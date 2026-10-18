import { createHmac } from "node:crypto";

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const FIREFOX_SPLIT_THRESHOLD = 900_000;
// Firefox rejects host→browser messages over 1 MiB. Re-serialized inside a part message,
// one UTF-16 code unit costs at most 3 bytes (a lone surrogate at a cut costs 6, at most twice per part).
export const PART_CHARS = 250_000;

// Firefox frames native messages in native byte order; every supported Mac is little-endian.
export function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class Decoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const messages = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) throw new Error(`Frame too large: ${length} bytes`);
      if (this.#buffer.length < 4 + length) break;
      messages.push(JSON.parse(this.#buffer.subarray(4, 4 + length).toString("utf8")));
      this.#buffer = this.#buffer.subarray(4 + length);
    }
    return messages;
  }
}

export function onMessages(stream, handler, onError = (err) => stream.destroy(err)) {
  const decoder = new Decoder();
  stream.on("data", (chunk) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (err) {
      onError(err);
      return;
    }
    for (const msg of messages) if (typeof msg === "object" && msg !== null) handler(msg);
  });
}

export function splitForFirefox(msg, msgId) {
  const json = JSON.stringify(msg);
  if (Buffer.byteLength(json, "utf8") <= FIREFOX_SPLIT_THRESHOLD) return [msg];
  const total = Math.ceil(json.length / PART_CHARS);
  const parts = [];
  for (let index = 0; index < total; index++) {
    parts.push({ type: "part", msgId, index, total, data: json.slice(index * PART_CHARS, (index + 1) * PART_CHARS) });
  }
  return parts;
}

export const bridgeProof = (key, nonce) => createHmac("sha256", Buffer.from(key, "hex")).update(nonce).digest("hex");
