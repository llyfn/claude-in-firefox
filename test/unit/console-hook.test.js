import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadContent } from "./helpers/dom.js";

const hook = () => loadContent("", ["console-hook.js"]).__cf.consoleHook;

test("console arguments render as compact JSON-like text with errors as name and message", () => {
  const { format } = hook();
  assert.equal(format("raw"), "raw");
  assert.equal(format(undefined), "undefined");
  assert.equal(format(null), "null");
  assert.equal(format(42), "42");
  assert.equal(format({ n: 1 }), '{"n":1}');
  assert.equal(format({ a: [1, "x", { b: null }] }), '{"a":[1,"x",{"b":null}]}');
  assert.match(format(new TypeError("bad")), /^TypeError: bad\n {4}\S/);
  assert.equal(format({ e: new TypeError("inner") }), '{"e":TypeError: inner}');
});

test("console formatting shows getters without invoking them and marks cycles", () => {
  const { format } = hook();
  let ran = false;
  const value = { ok: 1, get trap() { ran = true; return 2; } };
  value.self = value;
  assert.equal(format(value), '{"ok":1,"trap":[getter],"self":[Circular]}');
  assert.equal(ran, false);
});

test("console formatting stops at depth 3, 100 array items and 2000 characters", () => {
  const { format } = hook();
  assert.equal(format({ l1: { l2: { l3: { l4: { l5: 1 } } } } }), '{"l1":{"l2":{"l3":{"l4":[Object]}}}}');
  const long = format(Array.from({ length: 250 }, (_, i) => i));
  assert.match(long, /^\[0,1,/);
  assert.match(long, /,99,…150 more\]$/);
  const wide = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => "x".repeat(50)));
  assert.ok(format(wide).length < 2_100);
});

test("console queue keeps 1000 entries per flush and reports how many were dropped", async () => {
  const w = loadContent("", ["console-hook.js"]);
  const sent = [];
  w.browser = { runtime: { sendMessage: (message) => { sent.push(message); return Promise.resolve(); } } };
  for (let i = 0; i < 1005; i++) w.__cf.consoleHook.record("log", `m${i}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(sent.length, 1);
  const { entries } = sent[0];
  assert.equal(entries.length, 1001);
  assert.equal(entries[999].text, "m999");
  assert.equal(entries[1000].text, "[5 console messages dropped]");
});

test("a huge message and a huge page URL are sent truncated with a marker", async () => {
  const w = loadContent("", ["console-hook.js"], { url: `https://shop.test/?${"y".repeat(100_000)}` });
  const sent = [];
  w.browser = { runtime: { sendMessage: (message) => { sent.push(message); return Promise.resolve(); } } };
  w.__cf.consoleHook.record("log", "x".repeat(100_000));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [entry] = sent[0].entries;
  assert.match(entry.text, /^x+…\[truncated\]$/);
  assert.match(entry.url, /^https:\/\/shop\.test\/\?y+…\[truncated\]$/);
  assert.ok(entry.text.length + entry.url.length < 10_000, `${entry.text.length + entry.url.length} characters sent`);
});

test("error stacks are limited to 10 lines and an unreadable stack is skipped", () => {
  const { format } = hook();
  const deep = new Error("deep");
  deep.stack = ["Error: deep", ...Array.from({ length: 15 }, (_, i) => `f${i}@https://a.test/app.js:${i}:1`)].join("\n");
  const lines = format(deep).split("\n");
  assert.equal(lines[0], "Error: deep");
  assert.equal(lines.length, 11);
  assert.equal(lines[1], "    Error: deep");
  const sealed = new Error("sealed");
  Object.defineProperty(sealed, "stack", { get() { throw new Error("no"); } });
  assert.equal(format(sealed), "Error: sealed");
});

test("uncaught errors include the stack of an Error and no stack from other values", async () => {
  const w = loadContent("", []);
  w.wrappedJSObject = w;
  w.exportFunction = (fn, target, { defineAs }) => { target[defineAs] = fn; };
  w.eval(readFileSync(new URL("../../extension/content/console-hook.js", import.meta.url), "utf8"));
  const sent = [];
  w.browser = { runtime: { sendMessage: (message) => { sent.push(message); return Promise.resolve(); } } };
  const error = new w.Error("boom");
  error.stack = "f@https://a.test/app.js:3:7";
  w.dispatchEvent(new w.ErrorEvent("error", { message: "boom", filename: "https://a.test/app.js", lineno: 3, colno: 7, error }));
  w.dispatchEvent(new w.ErrorEvent("error", { message: "plain", filename: "https://a.test/app.js", lineno: 3, colno: 7, error: { stack: "x@y" } }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sent.length, 1);
  const [withStack, withoutStack] = sent[0].entries;
  assert.equal(withStack.level, "exception");
  assert.equal(withStack.text, "boom (https://a.test/app.js:3:7)\n    f@https://a.test/app.js:3:7");
  assert.equal(withoutStack.text, "plain (https://a.test/app.js:3:7)");
});
