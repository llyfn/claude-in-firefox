import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { bridgeProof, encode, onMessages, splitForFirefox } from "./framing.js";
import { bridgeAddress, bridgeKey, ensureSocketDir, isMain } from "./paths.js";

export async function startNativeHost({ input, output, address, key = null, platform = process.platform }) {
  const unix = platform !== "win32";
  if (unix) {
    await ensureSocketDir(path.dirname(address));
    await claimSocketPath(address);
  }

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
      if (msg.type === "hello") {
        client.sessionId = msg.sessionId;
        if (key && typeof msg.nonce === "string") socket.write(encode({ type: "welcome", proof: bridgeProof(key, msg.nonce) }));
      } else if (msg.type === "call" && client.sessionId) {
        toFirefox({ type: "call", id: `${clientId}:${msg.id}`, sessionId: client.sessionId, tool: msg.tool, args: msg.args });
      }
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
    server.once("error", (err) => reject(err.code === "EADDRINUSE" ? new Error(`Another native host is already serving ${address}`) : err));
    server.listen(address, resolve);
  });
  if (unix) await fsp.chmod(address, 0o600);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    for (const { socket } of clients.values()) socket.destroy();
    if (unix) fs.rmSync(address, { force: true });
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
    const host = await startNativeHost({ input: process.stdin, output: process.stdout, address: bridgeAddress(), key: bridgeKey() });
    process.stdin.on("end", () => process.exit(0));
    process.on("SIGTERM", () => { host.close(); process.exit(0); });
  } catch (err) {
    process.stderr.write(`claude-firefox native host: ${err.message}\n`);
    process.exit(1);
  }
}
