import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { coerceArgs } from "./coerce.js";
import { encode, onMessages } from "./framing.js";
import { PACKAGE_VERSION, bridgeAddress, isMain, verifySocketDir } from "./paths.js";
import { TOOLS, TOOL_BY_NAME } from "./tools.js";

export const CALL_TIMEOUT_MS = 30_000;
export const BATCH_TIMEOUT_MS = 90_000;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const NOT_CONNECTED_MESSAGE = "Firefox extension not connected — is Firefox running with the Claude Code Bridge for Firefox add-on installed, and has `npx @llyfn/claude-in-firefox install` been run?";

const MIME_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".html": "text/html", ".zip": "application/zip",
};

export class BridgeClient {
  #address;
  #platform;
  #socket = null;
  #connecting = null;
  #pending = new Map();
  #nextId = 1;

  constructor({ address, sessionId, platform = process.platform }) {
    this.#address = typeof address === "function" ? address : () => address;
    this.#platform = platform;
    this.sessionId = sessionId;
  }

  async call(tool, args, timeoutMs) {
    const socket = await this.#connect();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${tool} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      socket.write(encode({ type: "call", id, sessionId: this.sessionId, tool, args }));
    });
  }

  close() {
    this.#socket?.destroy();
  }

  #connect() {
    if (this.#socket) return Promise.resolve(this.#socket);
    this.#connecting ??= this.#open().finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async #open() {
    let address;
    try {
      address = this.#address();
    } catch (err) {
      throw new Error(`${NOT_CONNECTED_MESSAGE} (${err.message})`);
    }
    if (this.#platform !== "win32") {
      try {
        await verifySocketDir(path.dirname(address));
      } catch (err) {
        throw new Error(err.code === "ENOENT" ? NOT_CONNECTED_MESSAGE : err.message);
      }
    }
    const socket = net.connect(address);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", () => reject(new Error(NOT_CONNECTED_MESSAGE)));
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.#socket === socket) this.#socket = null;
      for (const pending of this.#pending.values()) pending.reject(new Error("Connection to Firefox lost"));
      this.#pending.clear();
    });
    onMessages(socket, (msg) => {
      if (msg.type !== "result") return;
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      pending.resolve({ content: msg.content, isError: !!msg.isError });
    });
    socket.write(encode({ type: "hello", sessionId: this.sessionId }));
    this.#socket = socket;
    return socket;
  }
}

export const callTimeout = (name, args) => (name === "computer" && args.action === "wait" ? Math.max(CALL_TIMEOUT_MS, Number(args.duration) * 1000 + 10_000 || 0) : CALL_TIMEOUT_MS);

export async function callTool(bridge, name, rawArgs = {}, limitMs = Infinity) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const args = coerceArgs(tool.inputSchema, rawArgs ?? {});
  const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined);
  if (missing.length) throw new Error(`${name}: missing required argument(s): ${missing.join(", ")}`);
  const timeoutMs = Math.min(callTimeout(name, args), limitMs);
  if (name === "browser_batch") return runBatch(bridge, args.actions);
  if (name === "file_upload") return bridge.call(name, await withFileContents(args), timeoutMs);
  return bridge.call(name, args, timeoutMs);
}

async function runBatch(bridge, actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 50) throw new Error("browser_batch: actions must contain 1-50 {name, input} items");
  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  const content = [];
  for (const [index, action] of actions.entries()) {
    const name = action?.name;
    let result;
    try {
      if (name === "browser_batch") throw new Error("browser_batch cannot be nested");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("browser_batch timed out after 90s");
      result = await callTool(bridge, name, action.input ?? {}, remaining);
    } catch (err) {
      result = { content: [{ type: "text", text: err.message }], isError: true };
    }
    for (const block of result.content) content.push(block.type === "text" ? { ...block, text: `[${index}:${name}] ${block.text}` } : block);
    if (result.isError) return { content, isError: true };
  }
  return { content };
}

async function withFileContents({ paths, ...rest }) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("file_upload: paths must be a non-empty array");
  const files = [];
  let total = 0;
  for (const p of paths) {
    const resolved = path.resolve(p);
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error(`file_upload: ${resolved} is not a regular file`);
    total += stat.size;
    if (total > MAX_UPLOAD_BYTES) throw new Error("file_upload: total size exceeds 10 MB");
    files.push({
      name: path.basename(resolved),
      mimeType: MIME_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
      base64: (await fsp.readFile(resolved)).toString("base64"),
    });
  }
  return { ...rest, files };
}

export function createMcpServer({ bridge }) {
  const server = new Server({ name: "claude-in-firefox", version: PACKAGE_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      return await callTool(bridge, params.name, params.arguments ?? {});
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  });
  return server;
}

export async function runMcpServer() {
  const bridge = new BridgeClient({ address: () => bridgeAddress(), sessionId: randomUUID() });
  await createMcpServer({ bridge }).connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));
}

if (isMain(import.meta.url)) await runMcpServer();
