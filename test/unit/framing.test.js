import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Decoder, FIREFOX_SPLIT_THRESHOLD, encode, onMessages, splitForFirefox } from "../../host/src/framing.js";

test("encode prefixes the UTF-8 body with its little-endian byte length", () => {
  const buf = encode({ a: "é" });
  assert.equal(buf.readUInt32LE(0), Buffer.byteLength('{"a":"é"}'));
  assert.equal(buf.subarray(4).toString("utf8"), '{"a":"é"}');
});

test("decoder handles messages split across chunks and several messages in one chunk", () => {
  const decoder = new Decoder();
  const both = Buffer.concat([encode({ n: 1 }), encode({ n: 2 })]);
  assert.deepEqual(decoder.push(both.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(both.subarray(3, 12)), [{ n: 1 }]);
  assert.deepEqual(decoder.push(both.subarray(12)), [{ n: 2 }]);
});

test("decoder rejects frames above the size limit", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
  assert.throws(() => new Decoder().push(header), /Frame too large/);
});

test("onMessages reports malformed frames through onError", async () => {
  const stream = new PassThrough();
  const errors = [];
  onMessages(stream, () => assert.fail("no message expected"), (err) => errors.push(err));
  const body = Buffer.from("{not json");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stream.write(Buffer.concat([header, body]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
});

test("onMessages skips frames that are not objects and still delivers the next one", async () => {
  const stream = new PassThrough();
  const received = [];
  onMessages(stream, (msg) => received.push(msg), (err) => assert.fail(err));
  stream.write(Buffer.concat([null, 42, "x", true, { type: "hello" }].map(encode)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{ type: "hello" }]);
});

test("small messages are not split", () => {
  const msg = { type: "call", args: { a: 1 } };
  assert.deepEqual(splitForFirefox(msg, 1), [msg]);
});

test("large messages split into parts under 1 MiB that survive the wire and reassemble exactly", () => {
  const endsWithHighSurrogate = (part) => part.data.charCodeAt(part.data.length - 1) >= 0xd800 && part.data.charCodeAt(part.data.length - 1) <= 0xdbff;
  let msg;
  let parts;
  for (let pad = 0; pad < 8; pad++) {
    msg = { type: "call", args: { blob: "x".repeat(pad) + 'é한👋"\\'.repeat(200_000) } };
    parts = splitForFirefox(msg, 7);
    if (parts.slice(0, -1).some(endsWithHighSurrogate)) break;
  }
  assert.ok(parts.length > 1);
  assert.ok(parts.slice(0, -1).some(endsWithHighSurrogate), "a part boundary falls between a surrogate pair");
  for (const part of parts) {
    assert.equal(part.type, "part");
    assert.equal(part.msgId, 7);
    assert.equal(part.total, parts.length);
    assert.ok(encode(part).length <= 1024 * 1024, `part ${part.index} is ${encode(part).length} bytes`);
  }
  const overTheWire = parts.map((p) => JSON.parse(JSON.stringify(p)).data).join("");
  assert.deepEqual(JSON.parse(overTheWire), msg);
});
