import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { pageProgram } from "../../extension/background/tools/javascript.js";

async function run(code, { wrapAsync = false, blockEval = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="x" class="a b"></div></body>`, { runScripts: "outside-only" });
  if (blockEval) dom.window.eval = () => { throw new dom.window.EvalError("call to eval() blocked by CSP"); };
  return JSON.parse(await vm.runInContext(pageProgram(code, { nonce: "t", wrapAsync }), dom.getInternalVMContext()));
}

test("returns the value of the last expression", async () => {
  assert.deepEqual(await run("const a = 2; a * 21"), { ok: true, value: "42" });
});

test("awaits promises", async () => {
  assert.deepEqual(await run("Promise.resolve(6).then((n) => n * 7)"), { ok: true, value: "42" });
});

test("strings come back raw and objects as indented JSON", async () => {
  assert.equal((await run("'hello'")).value, "hello");
  assert.equal((await run("({ a: [1, 2], b: null })")).value, '{\n  "a": [\n    1,\n    2\n  ],\n  "b": null\n}');
});

test("describes DOM nodes, functions, cycles and long strings", async () => {
  assert.equal((await run("document.getElementById('x')")).value, "<div#x.a.b>");
  assert.equal((await run("(function named() {})")).value, "[Function named]");
  assert.match((await run("const o = {}; o.self = o; o")).value, /"self": "\[Circular\]"/);
  assert.match((await run("'z'.repeat(1500)")).value, /…\[500 more chars\]$/);
});

test("reports thrown errors with their name", async () => {
  const result = await run("nope.value");
  assert.equal(result.ok, false);
  assert.match(result.error, /^ReferenceError: nope is not defined/);
});

test("top-level await fails plainly and works once wrapped", async () => {
  const code = "const x = await Promise.resolve(5); return x * 2";
  const plain = await run(code);
  assert.equal(plain.ok, false);
  assert.match(plain.error, /await is only valid/);
  assert.deepEqual(await run(code, { wrapAsync: true }), { ok: true, value: "10" });
});

test("a CSP-blocked eval is reported so the sandbox fallback can run", async () => {
  const result = await run("1", { blockEval: true });
  assert.equal(result.cspBlocked, true);
});
