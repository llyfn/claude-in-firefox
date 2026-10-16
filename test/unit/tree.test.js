import test from "node:test";
import assert from "node:assert/strict";
import { formatFind, parseRef, renderTree, scoreNodes } from "../../extension/background/tree.js";
import { loadContent, stubLayout } from "./helpers/dom.js";

const render = (w, args = {}) => renderTree(w.__cf.tree.build(args).nodes);

test("roles, names, refs and attributes follow the line format", () => {
  const w = loadContent(`<nav><a href="/home">Home</a></nav><main><h1>Sign in</h1><form>
    <label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" value="a@b.c">
    <label><input type="checkbox" checked> Remember me</label>
    <button type="submit" disabled><span>Log in</span></button></form></main>`);
  const text = render(w);
  assert.match(text, /^navigation \[ref_\d+\]$/m);
  assert.match(text, /^ link "Home" \[ref_\d+\] href="\/home"$/m);
  assert.match(text, /^ heading "Sign in" \[ref_\d+\]$/m);
  assert.match(text, /textbox "Email" \[ref_\d+\] type="email" placeholder="you@example.com" value="a@b.c"/);
  assert.match(text, /checkbox "Remember me" \[ref_\d+\] \(checked\) type="checkbox"/);
  assert.match(text, /button "Log in" \[ref_\d+\] \(disabled\) type="submit"/);
});

test("password, one-time-code and card values are redacted and hidden inputs skipped", () => {
  const w = loadContent(`<input type="password" value="hunter2"><input autocomplete="one-time-code" value="123456">
    <input autocomplete="cc-number" value="4111111111111111"><input type="hidden" value="csrf-token">
    <input autocomplete="billing cc-name" value="Ada Lovelace">
    <select autocomplete="cc-exp-month"><option selected>01</option><option>02</option></select>`);
  const text = render(w);
  for (const secret of ["hunter2", "123456", "4111", "csrf-token", "Ada Lovelace"]) assert.ok(!text.includes(secret), secret);
  assert.equal(text.match(/value="\[value redacted\]"/g).length, 4);
  assert.match(text, /combobox "\[value redacted\]" \[ref_\d+\]/);
  assert.doesNotMatch(text, /option/);
});

test("select options are listed once under the select with selection and differing values", () => {
  const w = loadContent(`<label>Country <select><option value="us" selected>United States</option><option value="kr">Korea</option><option>Japan</option></select></label>`);
  const text = render(w);
  assert.match(text, /^label "Country" \[ref_\d+\]\n combobox "Country" \[ref_\d+\]\n  option "United States" \(selected\) value="us"\n  option "Korea" value="kr"\n  option "Japan"$/m);
});

test("refs are stable across builds and resolve to their elements", () => {
  const w = loadContent(`<button id="b">Press</button>`);
  const first = w.__cf.tree.build().nodes.find((n) => n.name === "Press").ref;
  w.document.body.insertAdjacentHTML("afterbegin", "<a href='#'>New link</a>");
  const second = w.__cf.tree.build().nodes.find((n) => n.name === "Press").ref;
  assert.equal(first, second);
  assert.equal(w.__cf.tree.resolve(first), w.document.getElementById("b"));
});

test("removed elements give a helpful stale-ref error", () => {
  const w = loadContent(`<button id="b">Press</button>`);
  const ref = w.__cf.tree.build().nodes[0].ref;
  w.document.getElementById("b").remove();
  assert.throws(() => w.__cf.tree.resolve(ref), new RegExp(`Element ${ref} not found — it may have been removed`));
  assert.throws(() => w.__cf.tree.resolve("ref_999"), /Element ref_999 not found/);
});

test("the interactive filter keeps only visible, on-screen controls", () => {
  const w = loadContent(`<button>On screen</button><button style="display:none">Hidden one</button>
    <button data-offscreen>Far below</button><p>Just a paragraph</p><button aria-hidden="true">Aria hidden</button>`);
  stubLayout(w);
  const text = render(w, { filter: "interactive" });
  assert.match(text, /button "On screen"/);
  assert.doesNotMatch(text, /Hidden one|Far below|Just a paragraph|Aria hidden/);
});

test("open shadow roots and same-origin iframes are traversed", () => {
  const w = loadContent(`<div id="host"></div><iframe id="f"></iframe>`);
  w.document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<button>Shadow button</button>";
  w.document.getElementById("f").contentDocument.body.innerHTML = "<a href='/in-frame'>Inside frame</a>";
  const text = render(w);
  assert.match(text, /button "Shadow button" \[ref_\d+\]/);
  assert.match(text, /^iframe \[ref_\d+\]\n link "Inside frame" \[ref_\d+\] href="\/in-frame"$/m);
});

test("refId focuses on one subtree and the frame prefix marks refs", () => {
  const w = loadContent(`<nav id="n"><a href="/a">Alpha</a></nav><main><a href="/b">Beta</a></main>`);
  const navRef = w.__cf.tree.build().nodes.find((n) => n.role === "navigation").ref;
  const text = render(w, { refId: navRef });
  assert.match(text, /Alpha/);
  assert.doesNotMatch(text, /Beta/);
  const framed = loadContent(`<button>X-ray</button>`);
  assert.match(framed.__cf.tree.build({ framePrefix: "f7_" }).nodes[0].ref, /^f7_ref_\d+$/);
});

test("very large pages are capped at 10000 nodes with a truncation note", () => {
  const w = loadContent(`<ul>${"<li><a href='#'>item</a></li>".repeat(6000)}</ul>`);
  const started = Date.now();
  const result = w.__cf.tree.build();
  assert.equal(result.truncated, true);
  assert.equal(result.nodes.length, 10_000);
  assert.ok(Date.now() - started < 10_000, "tree build should finish quickly");
  const text = renderTree(result.nodes, { truncatedNodes: true });
  assert.match(text, /\[output truncated at \d+ of \d+ characters/);
  assert.match(text, /\[truncated at 10000 elements/);
});

test("renderTree truncates at a line boundary with a note", () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({ level: 0, role: "button", name: `Button ${i}`, ref: `ref_${i}` }));
  const text = renderTree(nodes, { maxChars: 200 });
  const [body] = text.split("\n[output truncated");
  assert.ok(body.length <= 200);
  assert.ok(body.endsWith("]"));
  assert.match(text, /\[output truncated at \d+ of \d+ characters\. Pass a larger max_chars/);
  assert.equal(renderTree([]), "(no elements matched)");
});

test("parseRef reads frame prefixes and rejects anything else", () => {
  assert.deepEqual(parseRef("ref_12"), { frameId: 0, ref: "ref_12" });
  assert.deepEqual(parseRef("f7_ref_3"), { frameId: 7, ref: "f7_ref_3" });
  assert.throws(() => parseRef("button"), /Invalid ref "button"/);
});

test("find ranks name matches first and formats hits", () => {
  const nodes = [
    { level: 0, role: "button", name: "Cancel", ref: "ref_1", interactive: true },
    { level: 0, role: "button", name: "Subscribe now", ref: "ref_2", interactive: true },
    { level: 0, role: "textbox", name: "Search", ref: "ref_3", placeholder: "Search products", interactive: true },
    { level: 0, role: "heading", name: "Subscribe to our newsletter", ref: "ref_4" },
    { level: 1, role: "option", name: "Subscribe" },
  ];
  assert.equal(scoreNodes(nodes, "subscribe button")[0].node.ref, "ref_2");
  assert.equal(scoreNodes(nodes, "search box")[0].node.ref, "ref_3");
  assert.ok(scoreNodes(nodes, "subscribe").every((hit) => hit.node.ref));
  assert.deepEqual(scoreNodes(nodes, "zebra"), []);
  assert.match(formatFind(scoreNodes(nodes, "zebra"), "zebra"), /^No elements matched "zebra"/);
  assert.match(formatFind(scoreNodes(nodes, "cancel"), "cancel"), /^Found 1 element\(s\) matching "cancel", best first:\n\n- ref_1: button "Cancel"$/);
});
