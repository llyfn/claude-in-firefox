import { createReassembler } from "./reassemble.js";

export function connectNative({ api, name, onMessage }) {
  const reassembler = createReassembler();
  let port = null;
  let delay = 1000;

  const connect = () => {
    port = api.runtime.connectNative(name);
    port.onMessage.addListener((msg) => {
      delay = 1000;
      const full = msg.type === "part" ? reassembler.push(msg) : msg;
      if (full) onMessage(full);
    });
    port.onDisconnect.addListener((p) => {
      console.warn(`Firefox Bridge for Claude Code: native host disconnected (${p.error?.message ?? "closed"}); retrying in ${delay / 1000}s`);
      port = null;
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
  };
  connect();

  return { send: (msg) => port?.postMessage(msg) };
}
