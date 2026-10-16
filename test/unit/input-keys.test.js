import test from "node:test";
import assert from "node:assert/strict";
import { loadContent, plain } from "./helpers/dom.js";

const FILES = ["dom.js", "tree.js", "input.js"];
const focused = (html, selector = "input, textarea") => {
  const w = loadContent(html, FILES);
  const el = w.document.querySelector(selector);
  el.focus();
  return { w, el };
};

test("key specs parse names, xdotool aliases and chords", () => {
  const w = loadContent("", FILES);
  const parse = (spec) => [...w.__cf.input.parseKeySpec(spec)].map((c) => ({ key: c.key, code: c.code, mods: Object.keys(c.mods).filter((m) => c.mods[m]).join("+") }));
  assert.deepEqual(parse("Enter"), [{ key: "Enter", code: "Enter", mods: "" }]);
  assert.deepEqual(parse("cmd+a shift+Tab"), [{ key: "a", code: "KeyA", mods: "meta" }, { key: "Tab", code: "Tab", mods: "shift" }]);
  assert.deepEqual(parse("Page_Down BackSpace KP_Enter"), [{ key: "PageDown", code: "PageDown", mods: "" }, { key: "Backspace", code: "Backspace", mods: "" }, { key: "Enter", code: "NumpadEnter", mods: "" }]);
  assert.deepEqual(parse("ctrl+shift+r"), [{ key: "R", code: "KeyR", mods: "ctrl+shift" }]);
  assert.deepEqual(parse("cmd++ +"), [{ key: "+", code: "Equal", mods: "shift+meta" }, { key: "+", code: "Equal", mods: "shift" }]);
  assert.deepEqual(parse("F5"), [{ key: "F5", code: "F5", mods: "" }]);
  assert.throws(() => parse("Hyperspace"), /Unknown key: Hyperspace/);
  assert.throws(() => parse("hyper+a"), /Unknown modifier "hyper" in "hyper\+a"/);
});

test("zoom chords are refused and reload chords are handed back to the background", () => {
  const w = loadContent("", FILES);
  assert.throws(() => w.__cf.input.keys({ spec: "cmd+=" }), /zoom/);
  assert.deepEqual(plain(w.__cf.input.keys({ spec: "cmd+r" })), { reload: { bypassCache: false } });
  assert.deepEqual(plain(w.__cf.input.keys({ spec: "cmd+shift+r" })), { reload: { bypassCache: true } });
});

test("type fires key events per character and inserts text through the value-setter fallback", () => {
  const { w, el } = focused(`<input id="q">`);
  const keydowns = [];
  const inputs = [];
  el.addEventListener("keydown", (e) => keydowns.push(e.key));
  el.addEventListener("input", (e) => inputs.push(e.data));
  w.__cf.input.type({ text: "hé👋" });
  assert.equal(el.value, "hé👋");
  assert.deepEqual(keydowns, ["h", "é", "👋"]);
  assert.deepEqual(inputs, ["h", "é", "👋"]);
});

test("type refuses when nothing editable has focus", () => {
  const w = loadContent(`<button>Plain</button>`, FILES);
  assert.throws(() => w.__cf.input.type({ text: "x" }), /No editable element is focused \(focus is on <body>\)/);
});

test("a cancelled keydown suppresses the default action", () => {
  const { w, el } = focused(`<input>`);
  el.addEventListener("keydown", (e) => e.preventDefault());
  w.__cf.input.type({ text: "abc" });
  assert.equal(el.value, "");
});

test("Enter in a text field submits through the form's default button", () => {
  const { w } = focused(`<form><input name="q"><button>Go</button></form>`);
  let clicks = 0;
  let submits = 0;
  w.document.querySelector("button").addEventListener("click", () => clicks++);
  w.document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  w.__cf.input.keys({ spec: "Enter" });
  assert.equal(clicks, 1);
  assert.equal(submits, 1);
});

test("Tab and shift+Tab follow tab order, skipping disabled and negative tabindex", () => {
  const w = loadContent(`<input id="a"><input id="b" disabled><button id="c" tabindex="-1">C</button><a id="d" href="#">D</a><input id="e">`, FILES);
  w.document.getElementById("a").focus();
  w.__cf.input.keys({ spec: "Tab" });
  assert.equal(w.document.activeElement.id, "d");
  w.__cf.input.keys({ spec: "Tab" });
  assert.equal(w.document.activeElement.id, "e");
  w.__cf.input.keys({ spec: "shift+Tab" });
  assert.equal(w.document.activeElement.id, "d");
});

test("Backspace, Delete, Home, shift+arrows and cmd+a edit text fields", () => {
  const { w, el } = focused(`<input value="hello">`);
  el.setSelectionRange(5, 5);
  w.__cf.input.keys({ spec: "BackSpace" });
  assert.equal(el.value, "hell");
  w.__cf.input.keys({ spec: "Home Delete" });
  assert.equal(el.value, "ell");
  w.__cf.input.keys({ spec: "shift+Right shift+Right" });
  assert.deepEqual([el.selectionStart, el.selectionEnd], [0, 2]);
  w.__cf.input.keys({ spec: "cmd+a" });
  assert.deepEqual([el.selectionStart, el.selectionEnd], [0, 3]);
});

test("Space toggles a focused checkbox and newlines type into textareas", () => {
  const w = loadContent(`<input type="checkbox" id="c"><textarea id="t"></textarea>`, FILES);
  const box = w.document.getElementById("c");
  box.focus();
  w.__cf.input.keys({ spec: "space" });
  assert.equal(box.checked, true);
  const area = w.document.getElementById("t");
  area.focus();
  w.__cf.input.type({ text: "a\nb" });
  assert.equal(area.value, "a\nb");
});

test("the domain guard blocks typing once the page changed host", () => {
  const w = loadContent(`<input>`, FILES, { url: "https://evil.test/" });
  w.document.querySelector("input").focus();
  assert.throws(() => w.__cf.input.type({ text: "x", guard: { host: "good.test", action: "type" } }), /different domain during type/);
  assert.equal(w.document.querySelector("input").value, "");
});
