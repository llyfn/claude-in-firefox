import test from "node:test";
import assert from "node:assert/strict";
import { loadContent, plain, stubElementFromPoint, stubLayout } from "./helpers/dom.js";

const FILES = ["dom.js", "tree.js", "input.js"];
const TYPES = ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "contextmenu", "auxclick"];
const setup = (html, options) => {
  const w = loadContent(html, FILES, options);
  stubLayout(w);
  return w;
};
const recorder = (el) => {
  const seen = [];
  for (const type of TYPES) el.addEventListener(type, () => seen.push(type));
  return seen;
};
const refOf = (w, name) => w.__cf.tree.build().nodes.find((n) => n.name === name && n.role !== "label").ref;

test("a ref click dispatches the full pointer sequence, focuses the control and reports the point", () => {
  const w = setup(`<label for="q">Query</label><input id="q">`);
  const input = w.document.getElementById("q");
  const seen = recorder(input);
  const result = w.__cf.input.click({ ref: refOf(w, "Query") });
  assert.deepEqual(seen, ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  assert.equal(w.document.activeElement, input);
  assert.deepEqual(plain(result), { opened: [], point: { x: 60, y: 20 } });
});

test("double clicks carry click counts and right clicks open the context menu without clicking", () => {
  const w = setup(`<button>Target</button>`);
  const button = w.document.querySelector("button");
  const seen = recorder(button);
  const details = [];
  button.addEventListener("click", (e) => details.push(e.detail));
  w.__cf.input.click({ ref: refOf(w, "Target"), count: 2 });
  assert.deepEqual(details, [1, 2]);
  assert.ok(seen.includes("dblclick"));
  seen.length = 0;
  w.__cf.input.click({ ref: refOf(w, "Target"), button: "right" });
  assert.ok(seen.includes("contextmenu"));
  assert.ok(!seen.includes("click"));
});

test("coordinate clicks reach the element under the point inside open shadow roots", () => {
  const w = setup(`<div id="host"></div>`);
  const host = w.document.getElementById("host");
  const inner = w.document.createElement("button");
  host.attachShadow({ mode: "open" }).append(inner);
  stubElementFromPoint(w, () => host);
  w.ShadowRoot.prototype.elementFromPoint = function elementFromPoint() { return inner; };
  let clicks = 0;
  inner.addEventListener("click", () => clicks++);
  w.__cf.input.click({ x: 50, y: 50 });
  assert.equal(clicks, 1);
});

test("modifiers are carried, new-tab links are intercepted and unknown modifiers rejected", () => {
  const w = setup(`<a href="/next" target="_blank">Open</a><a href="/same">Same</a>`);
  const metas = [];
  w.document.addEventListener("click", (e) => metas.push(e.metaKey));
  assert.deepEqual(plain(w.__cf.input.click({ ref: refOf(w, "Open") })).opened, ["https://example.test/next"]);
  assert.deepEqual(plain(w.__cf.input.click({ ref: refOf(w, "Same"), modifiers: "cmd" })).opened, ["https://example.test/same"]);
  assert.deepEqual(metas, [false, true]);
  assert.throws(() => w.__cf.input.click({ ref: refOf(w, "Same"), modifiers: "hyper" }), /Unknown modifier: hyper/);
});

test("hover enters the new target and leaves the previous one", () => {
  const w = setup(`<button>One</button><button>Two</button>`);
  const [one] = w.document.querySelectorAll("button");
  const seenOne = recorder(one);
  const outs = [];
  one.addEventListener("mouseout", () => outs.push("out"));
  w.__cf.input.hover({ ref: refOf(w, "One") });
  w.__cf.input.hover({ ref: refOf(w, "Two") });
  assert.ok(seenOne.includes("mouseover"));
  assert.deepEqual(outs, ["out"]);
});

test("scroll moves the nearest scrollable ancestor unless the wheel event is cancelled", () => {
  const w = setup(`<div id="box" style="overflow-y:auto"><p id="p">content</p></div>`);
  const box = w.document.getElementById("box");
  Object.defineProperties(box, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  const scrolled = [];
  box.scrollBy = (options) => scrolled.push(options.top);
  stubElementFromPoint(w, () => w.document.getElementById("p"));
  w.__cf.input.scroll({ x: 10, y: 10, dx: 0, dy: 300 });
  assert.deepEqual(scrolled, [300]);
  box.addEventListener("wheel", (e) => e.preventDefault());
  w.__cf.input.scroll({ x: 10, y: 10, dx: 0, dy: 300 });
  assert.deepEqual(scrolled, [300]);
});
