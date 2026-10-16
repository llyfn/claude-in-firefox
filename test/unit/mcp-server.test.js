import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { encode, onMessages } from "../../host/src/framing.js";
import { BridgeClient, NOT_CONNECTED_MESSAGE, callTool } from "../../host/src/mcp-server.js";
import { TOOLS } from "../../host/src/tools.js";

const ok = (text) => ({ content: [{ type: "text", text }], isError: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeBridge(handler) {
  const calls = [];
  return { calls, call: async (tool, args, timeoutMs) => { calls.push({ tool, args, timeoutMs }); return handler(tool, args); } };
}

test("the 15 tools have unique names and object input schemas", () => {
  assert.equal(TOOLS.length, 15);
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, 15);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.type, "object", tool.name);
});

test("unknown tools and missing required arguments never reach Firefox", async () => {
  const bridge = fakeBridge(() => ok("unexpected"));
  await assert.rejects(callTool(bridge, "teleport", {}), /Unknown tool: teleport/);
  await assert.rejects(callTool(bridge, "navigate", { tabId: 1 }), /missing required argument\(s\): url/);
  assert.equal(bridge.calls.length, 0);
});

test("ordinary tools are forwarded with the 30 s timeout", async () => {
  const bridge = fakeBridge(() => ok("done"));
  assert.deepEqual(await callTool(bridge, "tabs_create", {}), ok("done"));
  assert.deepEqual(bridge.calls, [{ tool: "tabs_create", args: {}, timeoutMs: 30_000 }]);
});

test("browser_batch runs actions in order, prefixes text and passes images through", async () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/jpeg" };
  const bridge = fakeBridge((tool) => (tool === "computer" ? { content: [{ type: "text", text: "shot" }, image], isError: false } : ok(`ran ${tool}`)));
  const result = await callTool(bridge, "browser_batch", { actions: [{ name: "navigate", input: { tabId: 1, url: "x" } }, { name: "computer", input: { tabId: 1, action: "screenshot" } }] });
  assert.deepEqual(bridge.calls.map((c) => c.tool), ["navigate", "computer"]);
  assert.deepEqual(result.content, [{ type: "text", text: "[0:navigate] ran navigate" }, { type: "text", text: "[1:computer] shot" }, image]);
  assert.equal(result.isError, undefined);
});

test("browser_batch stops at the first error", async () => {
  const bridge = fakeBridge((tool) => (tool === "find" ? { content: [{ type: "text", text: "boom" }], isError: true } : ok("fine")));
  const result = await callTool(bridge, "browser_batch", {
    actions: [{ name: "find", input: { tabId: 1, query: "q" } }, { name: "tabs_create", input: {} }],
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: "[0:find] boom" }]);
  assert.deepEqual(bridge.calls.map((c) => c.tool), ["find"]);
});

test("browser_batch rejects nesting and bad action lists", async () => {
  const bridge = fakeBridge(() => ok("fine"));
  const nested = await callTool(bridge, "browser_batch", { actions: [{ name: "browser_batch", input: { actions: [] } }] });
  assert.equal(nested.isError, true);
  assert.match(nested.content[0].text, /cannot be nested/);
  await assert.rejects(callTool(bridge, "browser_batch", { actions: [] }), /1-50/);
});

test("file_upload reads files into base64 with names and mime types", async () => {
  const dir = fs.mkdtempSync("/tmp/cfb-upload-");
  fs.writeFileSync(path.join(dir, "note.txt"), "hello");
  const bridge = fakeBridge(() => ok("uploaded"));
  await callTool(bridge, "file_upload", { tabId: 1, ref: "ref_1", paths: [path.join(dir, "note.txt")] });
  assert.deepEqual(bridge.calls[0].args, { tabId: 1, ref: "ref_1", files: [{ name: "note.txt", mimeType: "text/plain", base64: Buffer.from("hello").toString("base64") }] });
});

test("file_upload rejects directories and totals over 10 MB", async () => {
  const dir = fs.mkdtempSync("/tmp/cfb-upload-");
  const big = path.join(dir, "big.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 10 * 1024 * 1024 + 1);
  const bridge = fakeBridge(() => ok("uploaded"));
  await assert.rejects(callTool(bridge, "file_upload", { tabId: 1, ref: "ref_1", paths: [dir] }), /is not a regular file/);
  await assert.rejects(callTool(bridge, "file_upload", { tabId: 1, ref: "ref_1", paths: [big] }), /exceeds 10 MB/);
  assert.equal(bridge.calls.length, 0);
});

async function fakeHost(socketPath, onCall) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    onMessages(socket, (msg) => {
      received.push(msg);
      if (msg.type === "call") onCall(msg, (reply) => socket.write(encode(reply)));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { received, close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }) };
}

test("BridgeClient reports not connected when no host is listening", async () => {
  const dir = fs.mkdtempSync("/tmp/cfb-mcp-");
  const client = new BridgeClient({ socketPath: path.join(dir, "bridge.sock"), sessionId: "s" });
  await assert.rejects(client.call("tabs_create", {}, 1000), { message: NOT_CONNECTED_MESSAGE });
  const missing = new BridgeClient({ socketPath: "/tmp/cfb-does-not-exist/bridge.sock", sessionId: "s" });
  await assert.rejects(missing.call("tabs_create", {}, 1000), { message: NOT_CONNECTED_MESSAGE });
});

test("BridgeClient sends hello once and resolves results by id", async (t) => {
  const socketPath = path.join(fs.mkdtempSync("/tmp/cfb-mcp-"), "bridge.sock");
  const host = await fakeHost(socketPath, (msg, reply) => reply({ type: "result", id: msg.id, content: [{ type: "text", text: `${msg.tool} ok` }], isError: false }));
  const client = new BridgeClient({ socketPath, sessionId: "s1" });
  t.after(async () => { client.close(); await host.close(); });
  const [a, b] = await Promise.all([client.call("tabs_create", {}, 1000), client.call("tabs_context", {}, 1000)]);
  assert.equal(a.content[0].text, "tabs_create ok");
  assert.equal(b.content[0].text, "tabs_context ok");
  assert.deepEqual(host.received.filter((m) => m.type === "hello"), [{ type: "hello", sessionId: "s1" }]);
  assert.equal(host.received.filter((m) => m.type === "call").every((m) => m.sessionId === "s1"), true);
});

test("BridgeClient times out slow calls", async (t) => {
  const socketPath = path.join(fs.mkdtempSync("/tmp/cfb-mcp-"), "bridge.sock");
  const host = await fakeHost(socketPath, () => {});
  const client = new BridgeClient({ socketPath, sessionId: "s" });
  t.after(async () => { client.close(); await host.close(); });
  await assert.rejects(client.call("navigate", {}, 50), /navigate timed out/);
});

test("BridgeClient fails pending calls when the host goes away and reconnects on the next call", async (t) => {
  const socketPath = path.join(fs.mkdtempSync("/tmp/cfb-mcp-"), "bridge.sock");
  const first = await fakeHost(socketPath, () => {});
  const client = new BridgeClient({ socketPath, sessionId: "s" });
  const pending = client.call("navigate", {}, 5000);
  await sleep(50);
  await first.close();
  await assert.rejects(pending, /Connection to Firefox lost/);
  fs.rmSync(socketPath, { force: true });
  const second = await fakeHost(socketPath, (msg, reply) => reply({ type: "result", id: msg.id, content: [], isError: false }));
  t.after(async () => { client.close(); await second.close(); });
  assert.deepEqual(await client.call("tabs_create", {}, 1000), { content: [], isError: false });
  assert.equal(second.received[0].type, "hello");
});
