import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bridgeAddress, nativeManifestPath } from "../../host/src/paths.js";
import { startFixtures } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_FIREFOX = {
  darwin: "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
  win32: "C:\\Program Files\\Firefox Developer Edition\\firefox.exe",
};
const FIREFOX = process.env.FIREFOX_BIN ?? DEFAULT_FIREFOX[process.platform];
const BIDI_TIMEOUT_MS = 30_000;

export const textOf = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
export const imagesOf = (result) => result.content.filter((b) => b.type === "image");

const isLive = (address) => new Promise((resolve) => {
  const probe = net.connect(address);
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
  ws.onclose = () => {
    for (const call of pending.values()) call.reject(new Error("WebDriver BiDi connection closed"));
    pending.clear();
  };
  const send = (method, params = {}, timeoutMs = BIDI_TIMEOUT_MS) => new Promise((resolve, reject) => {
    // A closed WebSocket drops what is sent without an error.
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`WebDriver BiDi connection closed before ${method}`));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} got no answer within ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const script = async (method, params) => {
    const reply = await send(method, { awaitPromise: false, ...params });
    if (reply.type === "exception") throw new Error(reply.exceptionDetails.text);
    return reply.result;
  };
  try {
    // "ignore" leaves page dialogs open, as they are in a Firefox no automation drives.
    await send("session.new", { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } } });
  } catch (err) {
    ws.close();
    throw err;
  }

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
    // Quits Firefox, which ends web-ext too. Windows has no SIGINT to send web-ext instead.
    async close() {
      await send("browser.close", {}, 5_000).catch(() => {});
      ws.close();
    },
  };
}

const exitWithin = (child, timeoutMs) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(true);
    return;
  }
  const onExit = () => { clearTimeout(timer); resolve(true); };
  const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, timeoutMs);
  child.once("exit", onExit);
});

async function stopWebExt(webExt, graceMs) {
  if (await exitWithin(webExt, graceMs)) return;
  // kill() on Windows terminates web-ext alone and leaves Firefox running.
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(webExt.pid), "/t", "/f"], { stdio: "ignore" });
  else webExt.kill("SIGINT");
  if (!(await exitWithin(webExt, 10_000))) webExt.kill("SIGKILL");
}

export async function startHarness() {
  if (!FIREFOX) throw new Error("Set FIREFOX_BIN to your Firefox Developer Edition binary.");
  if (!fs.existsSync(nativeManifestPath())) throw new Error("Native host manifest missing. Run `npm run install-host` first.");
  const address = bridgeAddress();
  if (await isLive(address)) throw new Error(`${address} is already served. Quit Firefox Developer Edition before running e2e.`);
  const fixtures = await startFixtures();
  // Without these, downloads land in the user's Downloads folder.
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "claude-firefox-e2e-downloads-"));
  const bidiPort = await freePort();
  const webExt = spawn(process.execPath, [
    path.join(ROOT, "node_modules/web-ext/bin/web-ext.js"),
    "run", "--source-dir", path.join(ROOT, "extension"), "--firefox", FIREFOX,
    "--no-reload", "--no-input", "--pref", "browser.tabs.groups.enabled=true", "--start-url", "about:blank",
    "--pref", "browser.download.folderList=2", "--pref", `browser.download.dir=${downloads}`, "--pref", "browser.download.alwaysOpenPanel=false",
    // The Remote Agent's recommended prefs would change focus handling, popup blocking and background throttling, which these tests rely on.
    `--arg=--remote-debugging-port=${bidiPort}`, "--pref", "remote.prefs.recommended=false",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  webExt.stdout.on("data", (d) => { output += d; });
  webExt.stderr.on("data", (d) => { output += d; });

  let bidi = null;
  const clients = [];
  const close = async () => {
    for (const client of clients) await client.close().catch(() => {});
    await bidi?.close();
    await stopWebExt(webExt, bidi ? 10_000 : 0);
    await fixtures.close();
    fs.rmSync(downloads, { recursive: true, force: true });
    await waitFor(async () => !(await isLive(address)), 10_000, () => `${address} is still served after Firefox quit`);
  };
  const connect = async () => {
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "host/src/cli.js"), "mcp"] }));
    clients.push(client);
    return {
      call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }),
      close: () => client.close(),
    };
  };

  let main;
  try {
    await waitFor(() => isLive(address), 90_000, () => `The extension never connected. web-ext output:\n${output}`);
    bidi = await connectBidi(bidiPort);
    main = await connect();
  } catch (err) {
    await close().catch(() => {});
    throw err;
  }

  return { fixtures, downloads, bidi, connect, call: main.call, close };
}
