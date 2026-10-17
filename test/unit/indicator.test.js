import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./helpers/dom.js";

function setup() {
  const w = loadContent("<p>Page</p>", ["indicator.js"]);
  // jsdom has neither matchMedia nor Element.animate; reduced motion skips the animation.
  w.matchMedia = () => ({ matches: true });
  const sent = [];
  w.browser = { runtime: { sendMessage: (message) => { sent.push(message); return Promise.resolve(); } } };
  const roots = [];
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function attachShadow(init) {
    const root = attach.call(this, { ...init, mode: "open" });
    roots.push(root);
    return root;
  };
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
