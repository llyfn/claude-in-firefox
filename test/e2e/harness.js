import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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

export async function startHarness() {
  if (!fs.existsSync(nativeManifestPath())) throw new Error("Native host manifest missing. Run `npm run install-host` first.");
  if (await socketIsLive()) throw new Error(`${SOCKET_PATH} is already served. Quit Firefox Developer Edition before running e2e.`);
  const fixtures = await startFixtures();
  const webExt = spawn(path.join(ROOT, "node_modules/.bin/web-ext"), [
    "run", "--source-dir", path.join(ROOT, "extension"), "--firefox", FIREFOX,
    "--no-reload", "--no-input", "--pref", "browser.tabs.groups.enabled=true", "--start-url", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  webExt.stdout.on("data", (d) => { output += d; });
  webExt.stderr.on("data", (d) => { output += d; });
  try {
    await waitFor(socketIsLive, 90_000, () => `The extension never connected. web-ext output:\n${output}`);
  } catch (err) {
    webExt.kill("SIGINT");
    await fixtures.close();
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
    connect,
    call: main.call,
    async close() {
      for (const client of clients) await client.close().catch(() => {});
      webExt.kill("SIGINT");
      await new Promise((resolve) => {
        const timer = setTimeout(() => { webExt.kill("SIGKILL"); resolve(); }, 15_000);
        webExt.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      await fixtures.close();
    },
  };
}
