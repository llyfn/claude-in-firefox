import test from "node:test";
import assert from "node:assert/strict";
import { loadContent, plain } from "./helpers/dom.js";

const FILES = ["dom.js", "tree.js", "form.js", "text.js"];
const refByName = (w, name) => {
  const node = w.__cf.tree.build().nodes.find((n) => n.name === name && n.role !== "label");
  assert.ok(node, `no control named ${name}`);
  return node.ref;
};
const set = (w, name, value, guard = null) => w.__cf.form.setValue({ ref: refByName(w, name), value, guard });

test("text inputs use the native setter so React-style value trackers see the change", () => {
  const w = loadContent(`<label for="n">Name</label><input id="n" value="old">`, FILES);
  const el = w.document.getElementById("n");
  const native = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value");
  let tracked = "old";
  Object.defineProperty(el, "value", { configurable: true, get() { return native.get.call(this); }, set(v) { tracked = String(v); native.set.call(this, v); } });
  const changes = [];
  el.addEventListener("input", () => { const now = native.get.call(el); if (now !== tracked) { tracked = now; changes.push(now); } });
  assert.equal(set(w, "Name", "new"), 'Set text value to "new" (previous: "old")');
  assert.deepEqual(changes, ["new"]);
});

test("selects match by value, exact text or case-insensitive text and list options on a miss", () => {
  const w = loadContent(`<label for="c">Country</label><select id="c"><option value="us">United States</option><option value="kr">Korea</option></select>`, FILES);
  const changes = [];
  w.document.getElementById("c").addEventListener("change", (e) => changes.push(e.target.value));
  assert.equal(set(w, "Country", "kr"), 'Selected "Korea" (previous: "United States")');
  set(w, "Country", "united states");
  assert.deepEqual(changes, ["kr", "us"]);
  assert.throws(() => set(w, "Country", "Japan"), /Option "Japan" not found\. Available options: "United States" \(value: "us"\), "Korea" \(value: "kr"\)/);
});

test("checkboxes need booleans and toggle through a click", () => {
  const w = loadContent(`<label><input type="checkbox" id="a"> I agree</label>`, FILES);
  let clicks = 0;
  w.document.getElementById("a").addEventListener("click", () => clicks++);
  assert.throws(() => set(w, "I agree", "yes"), /Checkbox requires a boolean value/);
  assert.equal(set(w, "I agree", true), "Set checkbox to true (previous: false)");
  assert.equal(set(w, "I agree", true), "Set checkbox to true (previous: true)");
  assert.equal(clicks, 1);
});

test("radios are selected, number inputs validated, textareas and contenteditable set", () => {
  const w = loadContent(`<label><input type="radio" name="s" value="l"> Large</label>
    <label for="q">Quantity</label><input id="q" type="number">
    <label for="b">Bio</label><textarea id="b"></textarea>
    <div contenteditable="true" aria-label="Notes">draft</div>`, FILES);
  assert.equal(set(w, "Large", "anything"), 'Selected radio "l"');
  assert.equal(w.document.querySelector("input[name=s]").checked, true);
  assert.throws(() => set(w, "Quantity", "many"), /A number input needs a numeric value/);
  assert.equal(set(w, "Quantity", 3), 'Set number value to "3" (previous: "")');
  assert.equal(set(w, "Bio", "Line one"), 'Set textarea value to "Line one" (previous: "")');
  assert.equal(set(w, "Notes", "final"), 'Set editable content to "final" (previous: "draft")');
});

test("sensitive values are redacted in the output", () => {
  const w = loadContent(`<label for="p">Password</label><input id="p" type="password" value="old-secret">`, FILES);
  assert.equal(set(w, "Password", "new-secret"), "Set password value to [redacted] (previous: [redacted])");
  assert.equal(w.document.getElementById("p").value, "new-secret");
});

test("unsupported elements and file inputs are refused", () => {
  const w = loadContent(`<button>Plain button</button><label for="f">Attachment</label><input id="f" type="file">`, FILES);
  assert.throws(() => set(w, "Plain button", "x"), /<button> is not a supported form input/);
  assert.throws(() => set(w, "Attachment", "x"), /Use file_upload for file inputs/);
});

test("the domain guard stops input when the page host changed", () => {
  const w = loadContent(`<label for="n">Name</label><input id="n">`, FILES, { url: "https://evil.test/" });
  assert.throws(() => set(w, "Name", "x", { host: "good.test", action: "form_input" }), /Page navigated to a different domain during form_input/);
  assert.equal(w.document.getElementById("n").value, "");
});

test("page text prefers the longest matching content element", () => {
  const w = loadContent(`<nav>Site navigation</nav><article>Short</article><article>The   much longer
    article text</article><footer>Footer</footer>`, FILES);
  assert.deepEqual(plain(w.__cf.text.pageText()), { title: "Test", url: "https://example.test/page", tag: "article", text: "The much longer\narticle text" });
});

test("page text falls back to the body", () => {
  const w = loadContent(`<div>Only a div</div>`, FILES);
  assert.equal(w.__cf.text.pageText().tag, "body");
});
