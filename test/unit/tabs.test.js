import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { withScheme } from "../../extension/background/tools/tabs.js";
import { framesSettled } from "../../extension/background/navigation.js";

const top = { frameId: 0, parentFrameId: -1 };
const child = { frameId: 7, parentFrameId: 0 };

test("framesSettled waits until the child frame is registered", async () => {
  const polls = [[top], [top], [top, child]];
  let calls = 0;
  const api = {
    tabs: { executeScript: async () => [[1, 1]] },
    webNavigation: { getAllFrames: async () => polls[Math.min(calls++, polls.length - 1)] },
  };
  await framesSettled(api, 1);
  assert.equal(calls, 3);
});

test("framesSettled waits until a child frame that is navigating leaves the initial about:blank", async () => {
  const polls = [[top, { ...child, url: "about:blank" }], [top, { ...child, url: "about:blank" }], [top, { ...child, url: "http://b.test/inner.html" }]];
  let calls = 0;
  const api = {
    tabs: { executeScript: async () => [[1, 1]] },
    webNavigation: { getAllFrames: async () => polls[Math.min(calls++, polls.length - 1)] },
  };
  await framesSettled(api, 1);
  assert.equal(calls, 3);
});

test("framesSettled does not wait for a child frame that stays blank", async () => {
  let calls = 0;
  const api = {
    tabs: { executeScript: async () => [[1, 0]] },
    webNavigation: { getAllFrames: async () => { calls++; return [top, { ...child, url: "about:blank" }]; } },
  };
  await framesSettled(api, 1);
  assert.equal(calls, 1);
});

test("framesSettled counts frames with a src or srcdoc as navigating, except lazy ones and about:blank", async () => {
  const dom = new JSDOM(`<iframe src="https://b.test/"></iframe><iframe srcdoc="<p>hi"></iframe><iframe></iframe><iframe src=" about:blank "></iframe>
    <iframe src="https://b.test/lazy" loading="LAZY"></iframe>`, { runScripts: "outside-only" });
  let counted;
  const api = {
    tabs: { executeScript: async (tabId, { code }) => { counted = Array.from(dom.window.eval(code)); return [counted]; } },
    webNavigation: { getAllFrames: async () => null },
  };
  await framesSettled(api, 1);
  assert.deepEqual(counted, [5, 2]);
});

test("framesSettled resolves when getAllFrames rejects", async () => {
  const api = {
    tabs: { executeScript: async () => [[1, 1]] },
    webNavigation: { getAllFrames: async () => { throw new Error("tab closed"); } },
  };
  await framesSettled(api, 1);
});

test("withScheme prefixes https to scheme-less URLs including host:port and keeps real schemes", () => {
  for (const url of ["localhost:3000", "example.com:8080/path", "example.com", "127.0.0.1:8080"]) assert.equal(withScheme(url), `https://${url}`);
  for (const url of ["http://a.test", "HTTPS://a.test", "ftp://a.test", "about:blank", "data:text/html,hi", "javascript:void 0", "view-source:https://a.test", "moz-extension://id/page.html", "file:///tmp/a.html"]) assert.equal(withScheme(url), url);
});
