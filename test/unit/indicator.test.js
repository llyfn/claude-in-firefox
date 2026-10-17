import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadContent, plain } from "./helpers/dom.js";

function setup({ reply } = {}) {
  const w = loadContent("<p>Page</p>", []);
  // jsdom has neither matchMedia nor Element.animate; reduced motion skips the animation.
  w.matchMedia = () => ({ matches: true });
  const sent = [];
  w.browser = { runtime: { sendMessage: (message) => { sent.push(message); return Promise.resolve(reply); } } };
  const roots = [];
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function attachShadow(init) {
    const root = attach.call(this, { ...init, mode: "open" });
    roots.push(root);
    return root;
  };
  w.eval(readFileSync(new URL("../../extension/content/indicator.js", import.meta.url), "utf8"));
  return { w, sent, roots, indicator: w.__cf.indicator };
}

test("the session pill offers Stop while active and Resume while stopped", () => {
  const { w, roots, indicator } = setup();
  indicator.session({ state: "active" });
  const host = w.document.querySelector("claude-firefox-indicator");
  assert.equal(host.style.display, "block");
  assert.match(roots[0].textContent, /Claude is using this window/);
  assert.equal(roots[0].querySelector("button").textContent, "Stop");
  indicator.session({ state: "stopped" });
  assert.match(roots[0].textContent, /Stopped/);
  assert.equal(roots[0].querySelector("button").textContent, "Resume");
  indicator.session({ state: null });
  assert.equal(host.style.display, "none");
});

test("script-generated clicks on the pill are ignored", () => {
  const { roots, sent, indicator } = setup();
  indicator.session({ state: "active" });
  sent.length = 0;
  roots[0].querySelector("button").click();
  assert.deepEqual(sent, []);
});

test("screenshots hide the pill and a host left by an earlier injection is replaced", () => {
  const { w, indicator } = setup();
  const stale = w.document.createElement("claude-firefox-indicator");
  w.document.documentElement.append(stale);
  indicator.session({ state: "active" });
  const hosts = w.document.querySelectorAll("claude-firefox-indicator");
  assert.equal(hosts.length, 1);
  assert.notEqual(hosts[0], stale);
  indicator.suspend();
  assert.equal(hosts[0].style.display, "none");
  indicator.resume();
  assert.equal(hosts[0].style.display, "block");
});

test("a state of null on a fresh page builds no host", () => {
  const { w, indicator } = setup();
  indicator.session({ state: null });
  assert.equal(w.document.querySelector("claude-firefox-indicator"), null);
});

test("the state answered to the injection query shows the pill", async () => {
  const { w, sent } = setup({ reply: { state: "stopped" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plain(sent), [{ type: "indicator.query" }]);
  assert.equal(w.document.querySelector("claude-firefox-indicator").style.display, "block");
});

test("the pill button never takes focus from the page", () => {
  const { w, roots, indicator } = setup();
  indicator.session({ state: "active" });
  const button = roots[0].querySelector("button");
  assert.equal(button.tabIndex, -1);
  const down = new w.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  button.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
});
