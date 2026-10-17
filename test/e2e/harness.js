import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SOCKET_PATH, nativeManifestPath } from "../../host/src/paths.js";
import { startFixtures } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIREFOX = process.env.FIREFOX_BIN ?? "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";

export const textOf = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
export const imagesOf = (result) => result.content.filter((b) => b.type === "image");

const socketIsLive = () => new Promise((resolve) => {
  const probe = net.connect(SOCKET_PATH);
  probe.once("connect", () => { probe.destroy(); resolve(true); });
  probe.once("error", () => resolve(false));
});

async function waitFor(check, timeoutMs, message) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message());
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const plain = (remote) => (remote.type === "array" ? remote.value.map(plain) : remote.value);

// WebDriver BiDi input is trusted, unlike the synthetic events the add-on dispatches, so it can press the Stop pill.
async function connectBidi(port) {
  let ws = null;
  await waitFor(async () => {
    ws = await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
      socket.onopen = () => resolve(socket);
      socket.onerror = () => resolve(null);
    });
    return ws !== null;
  }, 30_000, () => `WebDriver BiDi did not answer on port ${port}`);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.type === "event") {
      for (const listener of [...listeners]) listener(msg);
      return;
    }
    const call = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.type === "error") call?.reject(new Error(`${msg.error}: ${msg.message}`));
    else call?.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const script = async (method, params) => {
    const reply = await send(method, { awaitPromise: false, ...params });
    if (reply.type === "exception") throw new Error(reply.exceptionDetails.text);
    return reply.result;
  };
  // "ignore" leaves page dialogs open, as they are in a Firefox no automation drives.
  await send("session.new", { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } } });

  return {
    send,
    nextEvent(method, match = () => true, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const listener = (msg) => {
          if (msg.method !== method || !match(msg.params)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(msg.params);
        };
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`No ${method} event within ${timeoutMs} ms`));
        }, timeoutMs);
        listeners.add(listener);
      });
    },
    async contextOf(urlPart) {
      const { contexts } = await send("browsingContext.getTree", {});
      const found = contexts.find((c) => c.url.includes(urlPart));
      if (!found) throw new Error(`No tab shows ${urlPart}: ${contexts.map((c) => c.url).join(", ")}`);
      return found.context;
    },
    // Resolves to the shared id of the host's shadow root, closed ones included.
    async shadowRootOf(context, hostSelector) {
      const host = await script("script.evaluate", { expression: `document.querySelector(${JSON.stringify(hostSelector)})`, target: { context }, serializationOptions: { includeShadowTree: "all", maxDomDepth: 0 } });
      const root = host.value?.shadowRoot?.sharedId;
      if (!root) throw new Error(`${hostSelector} has no shadow root`);
      return root;
    },
    // Resolves to the shared id of the first match, searched for under the node whose shared id is within when one is given.
    async locate(context, selector, within) {
      const { nodes } = await send("browsingContext.locateNodes", { context, locator: { type: "css", value: selector }, ...(within ? { startNodes: [{ sharedId: within }] } : {}) });
      if (!nodes.length) throw new Error(`Nothing matches ${selector}`);
      return nodes[0].sharedId;
    },
    async evaluate(context, expression) {
      return plain(await script("script.evaluate", { expression, target: { context } }));
    },
    // Resolves to [x, y, text]: the element's center in viewport CSS pixels and its text.
    async centerOf(context, sharedId) {
      const fn = "(el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, el.textContent]; }";
      return plain(await script("script.callFunction", { functionDeclaration: fn, arguments: [{ sharedId }], target: { context } }));
    },
    click(context, x, y) {
      const actions = [{ type: "pointerMove", x: Math.round(x), y: Math.round(y), origin: "viewport" }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }];
      return send("input.performActions", { context, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });
    },
    async close() {
      await send("session.end").catch(() => {});
      ws.close();
    },
  };
}

export async function startHarness() {
  if (!fs.existsSync(nativeManifestPath())) throw new Error("Native host manifest missing. Run `npm run install-host` first.");
  if (await socketIsLive()) throw new Error(`${SOCKET_PATH} is already served. Quit Firefox Developer Edition before running e2e.`);
  const fixtures = await startFixtures();
  // Without these, downloads land in the user's Downloads folder.
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "claude-firefox-e2e-downloads-"));
  const removeDownloads = () => fs.rmSync(downloads, { recursive: true, force: true });
  const bidiPort = await freePort();
  const webExt = spawn(path.join(ROOT, "node_modules/.bin/web-ext"), [
    "run", "--source-dir", path.join(ROOT, "extension"), "--firefox", FIREFOX,
    "--no-reload", "--no-input", "--pref", "browser.tabs.groups.enabled=true", "--start-url", "about:blank",
    "--pref", "browser.download.folderList=2", "--pref", `browser.download.dir=${downloads}`, "--pref", "browser.download.alwaysOpenPanel=false",
    // The Remote Agent's recommended prefs would change focus handling, popup blocking and background throttling, which these tests rely on.
    `--arg=--remote-debugging-port=${bidiPort}`, "--pref", "remote.prefs.recommended=false",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  webExt.stdout.on("data", (d) => { output += d; });
  webExt.stderr.on("data", (d) => { output += d; });
  let bidi;
  try {
    await waitFor(socketIsLive, 90_000, () => `The extension never connected. web-ext output:\n${output}`);
    bidi = await connectBidi(bidiPort);
  } catch (err) {
    webExt.kill("SIGINT");
    await fixtures.close();
    removeDownloads();
    throw err;
  }

  const clients = [];
  const connect = async () => {
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "host/src/mcp-server.js")] }));
    clients.push(client);
    return {
      call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }),
      close: () => client.close(),
    };
  };
  const main = await connect();

  return {
    fixtures,
    downloads,
    bidi,
    connect,
    call: main.call,
    async close() {
      for (const client of clients) await client.close().catch(() => {});
      await bidi.close();
      webExt.kill("SIGINT");
      await new Promise((resolve) => {
        const timer = setTimeout(() => { webExt.kill("SIGKILL"); resolve(); }, 15_000);
        webExt.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      await fixtures.close();
      removeDownloads();
    },
  };
}
