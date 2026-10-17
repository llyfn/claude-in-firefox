import test from "node:test";
import assert from "node:assert/strict";
import { createDialogLog, formatDialog } from "../../extension/background/dialogs.js";

test("dialog reports read as the answer that was given", () => {
  assert.equal(formatDialog({ kind: "confirm", message: "Delete this item?", answer: true }), 'Dialog: confirm("Delete this item?") → OK');
  assert.equal(formatDialog({ kind: "alert", message: "Saved", answer: null }), 'Dialog: alert("Saved") → dismissed');
  assert.equal(formatDialog({ kind: "prompt", message: "Name?", answer: "Ada" }), 'Dialog: prompt("Name?") → "Ada"');
});

test("reports are taken once per tab, capped, and dropped with the tab", () => {
  const log = createDialogLog();
  for (let i = 0; i < 25; i++) log.add(1, "s", { kind: "alert", message: `m${i}`, answer: null });
  log.add(2, "s", { kind: "confirm", message: "x", answer: true });
  log.add(2, "s", { kind: "bogus", message: "y" });
  const taken = log.take(1, "s");
  assert.equal(taken.length, 20);
  assert.equal(taken[0], 'Dialog: alert("m5") → dismissed');
  assert.deepEqual(log.take(1, "s"), []);
  log.removeTab(2);
  assert.deepEqual(log.take(2, "s"), []);
});

test("reports are only returned to the session that was in the tab when they were made", () => {
  const log = createDialogLog();
  log.add(1, "a", { kind: "alert", message: "hi", answer: null });
  assert.deepEqual(log.take(1, "b"), []);
  assert.deepEqual(log.take(1, "a"), []);
});
