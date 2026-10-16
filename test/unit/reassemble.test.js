import test from "node:test";
import assert from "node:assert/strict";
import { createReassembler } from "../../extension/background/reassemble.js";

const partsOf = (msg, msgId, size) => {
  const json = JSON.stringify(msg);
  const total = Math.ceil(json.length / size);
  return Array.from({ length: total }, (_, index) => ({ type: "part", msgId, index, total, data: json.slice(index * size, (index + 1) * size) }));
};

test("parts arriving out of order reassemble into the original message", () => {
  const msg = { type: "call", id: "1:1", args: { text: "héllo 👋".repeat(50) } };
  const reassembler = createReassembler();
  const results = partsOf(msg, 3, 17).reverse().map((part) => reassembler.push(part));
  assert.deepEqual(results.filter(Boolean), [msg]);
  assert.deepEqual(results.at(-1), msg);
});

test("duplicate parts are ignored and incomplete messages return null", () => {
  const parts = partsOf({ a: "x".repeat(100) }, 1, 40);
  const reassembler = createReassembler();
  assert.equal(reassembler.push(parts[0]), null);
  assert.equal(reassembler.push(parts[0]), null);
  assert.equal(reassembler.push(parts[1]), null);
  assert.deepEqual(reassembler.push(parts[2]), { a: "x".repeat(100) });
});

test("parts older than the max age are discarded", () => {
  let now = 0;
  const reassembler = createReassembler({ now: () => now, maxAgeMs: 60_000 });
  const parts = partsOf({ a: "x".repeat(100) }, 1, 40);
  reassembler.push(parts[0]);
  now = 61_000;
  for (const part of parts.slice(1)) assert.equal(reassembler.push(part), null);
});
