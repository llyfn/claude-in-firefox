import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Decoder, FIREFOX_SPLIT_THRESHOLD, encode } from "../../host/src/framing.js";
import { startNativeHost } from "../../host/src/native-host.js";

const tempSocketPath = () => path.join(fs.mkdtempSync("/tmp/cfb-test-"), "sock", "bridge.sock");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function messageQueue(stream) {
  const decoder = new Decoder();
  const queue = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    for (const msg of decoder.push(chunk)) {
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    }
  });
  return { next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve))) };
}

async function startHost() {
  const input = new PassThrough();
  const output = new PassThrough();
  const socketPath = tempSocketPath();
  const host = await startNativeHost({ input, output, address: socketPath });
  return { input, socketPath, host, fromHost: messageQueue(output) };
}

async function connectClient(socketPath) {
  const socket = net.connect(socketPath);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, messages: messageQueue(socket), send: (msg) => socket.write(encode(msg)) };
}

test("calls are forwarded with a client-prefixed id and results are routed back", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  const client = await connectClient(h.socketPath);
  client.send({ type: "hello", sessionId: "s1" });
  client.send({ type: "call", id: 5, sessionId: "s1", tool: "navigate", args: { url: "x" } });
  assert.deepEqual(await h.fromHost.next(), { type: "call", id: "1:5", sessionId: "s1", tool: "navigate", args: { url: "x" } });
  h.input.write(encode({ type: "result", id: "1:5", content: [{ type: "text", text: "ok" }], isError: false }));
  assert.deepEqual(await client.messages.next(), { type: "result", id: 5, content: [{ type: "text", text: "ok" }], isError: false });
  client.socket.destroy();
});

test("calls use the session announced in hello and are ignored before it", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  const client = await connectClient(h.socketPath);
  client.send({ type: "call", id: 1, sessionId: "forged", tool: "t", args: {} });
  client.send({ type: "hello", sessionId: "real" });
  client.send({ type: "call", id: 2, sessionId: "forged", tool: "t", args: {} });
  assert.deepEqual(await h.fromHost.next(), { type: "call", id: "1:2", sessionId: "real", tool: "t", args: {} });
  client.socket.destroy();
});

test("results go only to the client that made the call", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  const a = await connectClient(h.socketPath);
  const b = await connectClient(h.socketPath);
  a.send({ type: "hello", sessionId: "A" });
  b.send({ type: "hello", sessionId: "B" });
  a.send({ type: "call", id: 1, sessionId: "A", tool: "t", args: {} });
  b.send({ type: "call", id: 1, sessionId: "B", tool: "t", args: {} });
  const forwarded = [await h.fromHost.next(), await h.fromHost.next()];
  const forB = forwarded.find((m) => m.sessionId === "B");
  h.input.write(encode({ type: "result", id: forB.id, content: [], isError: false }));
  assert.equal((await b.messages.next()).id, 1);
  let aReceived = false;
  a.messages.next().then(() => { aReceived = true; });
  await sleep(50);
  assert.equal(aReceived, false);
  a.socket.destroy();
  b.socket.destroy();
});

test("a disconnecting client produces session_closed for its session", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  const client = await connectClient(h.socketPath);
  client.send({ type: "hello", sessionId: "s9" });
  await sleep(20);
  client.socket.destroy();
  assert.deepEqual(await h.fromHost.next(), { type: "session_closed", sessionId: "s9" });
});

test("calls larger than the Firefox limit arrive as parts", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  const client = await connectClient(h.socketPath);
  const args = { files: [{ base64: "A".repeat(FIREFOX_SPLIT_THRESHOLD * 2) }] };
  client.send({ type: "hello", sessionId: "s" });
  client.send({ type: "call", id: 1, sessionId: "s", tool: "file_upload", args });
  const first = await h.fromHost.next();
  assert.equal(first.type, "part");
  const parts = [first];
  while (parts.length < first.total) parts.push(await h.fromHost.next());
  assert.deepEqual(JSON.parse(parts.map((p) => p.data).join("")).args, args);
  client.socket.destroy();
});

test("the socket is private and a stale socket file is replaced", async (t) => {
  const socketPath = tempSocketPath();
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(socketPath, "");
  const host = await startNativeHost({ input: new PassThrough(), output: new PassThrough(), address: socketPath });
  t.after(() => host.close());
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
});

test("a second host refuses to start while the first is serving", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  await assert.rejects(startNativeHost({ input: new PassThrough(), output: new PassThrough(), address: h.socketPath }), /already serving/);
});

test("Firefox closing stdin removes the socket", async () => {
  const h = await startHost();
  h.input.end();
  await sleep(20);
  assert.equal(fs.existsSync(h.socketPath), false);
});

test("with the Windows transport the host skips directory checks and reports a busy address", async (t) => {
  const dir = fs.mkdtempSync("/tmp/cfb-win-");
  fs.chmodSync(dir, 0o755);
  const address = path.join(dir, "bridge.sock");
  const first = await startNativeHost({ input: new PassThrough(), output: new PassThrough(), address, platform: "win32" });
  t.after(() => first.close());
  await assert.rejects(startNativeHost({ input: new PassThrough(), output: new PassThrough(), address, platform: "win32" }), { message: `Another native host is already serving ${address}` });
});
