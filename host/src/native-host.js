import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { encode, onMessages, splitForFirefox } from "./framing.js";
import { SOCKET_PATH, ensureSocketDir, isMain } from "./paths.js";

export async function startNativeHost({ input, output, socketPath }) {
  await ensureSocketDir(path.dirname(socketPath));
  await claimSocketPath(socketPath);

  const clients = new Map();
  let nextClientId = 1;
  let nextMsgId = 1;
  const toFirefox = (msg) => {
    for (const part of splitForFirefox(msg, nextMsgId++)) output.write(encode(part));
  };

  const server = net.createServer((socket) => {
    const clientId = nextClientId++;
    const client = { socket, sessionId: null };
    clients.set(clientId, client);
    onMessages(socket, (msg) => {
      if (msg.type === "hello") client.sessionId = msg.sessionId;
      else if (msg.type === "call") toFirefox({ type: "call", id: `${clientId}:${msg.id}`, sessionId: msg.sessionId, tool: msg.tool, args: msg.args });
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clients.delete(clientId);
      if (client.sessionId) toFirefox({ type: "session_closed", sessionId: client.sessionId });
    });
  });

  onMessages(
    input,
    (msg) => {
      if (msg.type !== "result" || typeof msg.id !== "string") return;
      const sep = msg.id.indexOf(":");
      clients.get(Number(msg.id.slice(0, sep)))?.socket.write(encode({ ...msg, id: Number(msg.id.slice(sep + 1)) }));
    },
    (err) => process.stderr.write(`claude-firefox native host: bad message from Firefox: ${err.message}\n`),
  );

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await fsp.chmod(socketPath, 0o600);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    for (const { socket } of clients.values()) socket.destroy();
    fs.rmSync(socketPath, { force: true });
  };
  input.on("end", close);
  return { close };
}

async function claimSocketPath(socketPath) {
  if (!fs.existsSync(socketPath)) return;
  const live = await new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
  if (live) throw new Error(`Another native host is already serving ${socketPath}`);
  await fsp.rm(socketPath, { force: true });
}

if (isMain(import.meta.url)) {
  try {
    const host = await startNativeHost({ input: process.stdin, output: process.stdout, socketPath: SOCKET_PATH });
    process.stdin.on("end", () => process.exit(0));
    process.on("SIGTERM", () => { host.close(); process.exit(0); });
  } catch (err) {
    process.stderr.write(`claude-firefox native host: ${err.message}\n`);
    process.exit(1);
  }
}
