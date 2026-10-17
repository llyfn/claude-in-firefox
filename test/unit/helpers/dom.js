import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const CONTENT = new URL("../../../extension/content/", import.meta.url);

export function loadContent(html, files = ["tree.js"], { url = "https://example.test/page", before } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Test</title></head><body>${html}</body></html>`, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.PointerEvent ??= w.MouseEvent;
  w.Element.prototype.scrollIntoView = function scrollIntoView() {};
  w.Element.prototype.checkVisibility = function checkVisibility() { return true; };
  w.Document.prototype.execCommand = function execCommand() { return false; };
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
  before?.(w);
  for (const file of files) w.eval(readFileSync(new URL(file, CONTENT), "utf8"));
  return w;
}

export function stubLayout(w) {
  w.Element.prototype.getClientRects = function getClientRects() { return [{}]; };
  w.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const top = this.hasAttribute("data-offscreen") ? 5000 : 10;
    return { left: 10, top, right: 110, bottom: top + 20, width: 100, height: 20, x: 10, y: top };
  };
}

export function stubElementFromPoint(w, pick) {
  w.Document.prototype.elementFromPoint = function elementFromPoint(x, y) { return pick(x, y, this); };
}

// Objects created inside the jsdom realm have that realm's prototypes, which deepStrictEqual rejects.
export const plain = (value) => JSON.parse(JSON.stringify(value));
