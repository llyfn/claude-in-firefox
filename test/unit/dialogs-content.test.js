import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./helpers/dom.js";

function setup({ on = false } = {}) {
  const sent = [];
  const shown = [];
  const w = loadContent("", ["dialogs.js"], {
    before(w) {
      w.alert = (...args) => { shown.push(["alert", ...args]); };
      w.confirm = (...args) => { shown.push(["confirm", ...args]); return false; };
      w.prompt = (...args) => { shown.push(["prompt", ...args]); return null; };
      w.wrappedJSObject = w;
      w.exportFunction = (fn, target, { defineAs }) => { target[defineAs] = fn; return fn; };
      w.browser = { runtime: { sendMessage: (message) => { sent.push(message); return Promise.resolve(message.type === "dialogs.query" ? { on } : undefined); } } };
    },
  });
  return { w, sent, shown };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("outside a session the page's own dialogs run", async () => {
  const { w, shown, sent } = setup();
  await tick();
  assert.equal(w.confirm("Sure?"), false);
  w.alert();
  assert.deepEqual(shown, [["confirm", "Sure?"], ["alert"]]);
  assert.deepEqual(sent.map((m) => m.type), ["dialogs.query"]);
});

test("in a session tab dialogs are answered and reported without showing", async () => {
  const { w, shown, sent } = setup({ on: true });
  await tick();
  assert.equal(w.confirm("Delete this item?"), true);
  assert.equal(w.prompt("Name?", "Ada"), "Ada");
  assert.equal(w.prompt("Age?"), "");
  assert.equal(w.alert("Saved"), undefined);
  assert.deepEqual(shown, []);
  const reports = sent.filter((m) => m.type === "dialog").map(({ kind, message, answer }) => [kind, message, answer]);
  assert.deepEqual(reports, [["confirm", "Delete this item?", true], ["prompt", "Name?", "Ada"], ["prompt", "Age?", ""], ["alert", "Saved", null]]);
});

test("the background switches auto-answering on and off", () => {
  const { w, shown } = setup();
  w.__cf.dialogs.enable({ on: true });
  w.confirm("x");
  w.__cf.dialogs.enable({ on: false });
  w.confirm("y");
  assert.deepEqual(shown, [["confirm", "y"]]);
});

test("in a session tab the page's beforeunload handlers never run", () => {
  const { w } = setup();
  let ran = 0;
  w.addEventListener("beforeunload", () => { ran++; });
  w.__cf.dialogs.enable({ on: true });
  w.dispatchEvent(new w.Event("beforeunload"));
  w.__cf.dialogs.enable({ on: false });
  w.dispatchEvent(new w.Event("beforeunload"));
  assert.equal(ran, 1);
});
