import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { tabTools, withScheme } from "../../extension/background/tools/tabs.js";
import { framesSettled } from "../../extension/background/navigation.js";

const top = { frameId: 0, parentFrameId: -1 };
const child = { frameId: 7, parentFrameId: 0 };
const loaded = { ...child, url: "http://b.test/inner.html" };
const answers = async () => ({ error: "Unknown content op ping" });

test("framesSettled waits until the child frame is registered", async () => {
  const polls = [[top], [top], [top, child]];
  let calls = 0;
  const api = {
    tabs: { executeScript: async () => [[1, 1]], sendMessage: answers },
    webNavigation: { getAllFrames: async () => polls[Math.min(calls++, polls.length - 1)] },
  };
  await framesSettled(api, 1);
  assert.equal(calls, 3);
});

test("framesSettled waits until a child frame that is navigating leaves the initial about:blank", async () => {
  const polls = [[top, { ...child, url: "about:blank" }], [top, { ...child, url: "about:blank" }], [top, loaded]];
  let calls = 0;
  const api = {
    tabs: { executeScript: async () => [[1, 1]], sendMessage: answers },
    webNavigation: { getAllFrames: async () => polls[Math.min(calls++, polls.length - 1)] },
  };
  await framesSettled(api, 1);
  assert.equal(calls, 3);
});

test("framesSettled waits until the content scripts of a loaded child frame answer", async () => {
  const pinged = [];
  let listening = false;
  const api = {
    tabs: {
      executeScript: async () => [[1, 1]],
      sendMessage: async (tabId, msg, { frameId }) => {
        pinged.push(frameId);
        if (!listening) {
          listening = pinged.length === 2;
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return { error: `Unknown content op ${msg.op}` };
      },
    },
    webNavigation: { getAllFrames: async () => [top, loaded] },
  };
  await framesSettled(api, 1);
  assert.deepEqual(pinged, [7, 7, 7]);
});

test("framesSettled gives up on a child frame that never answers once its one-second budget is spent", { timeout: 5000 }, async () => {
  const api = {
    tabs: { executeScript: async () => [[1, 1]], sendMessage: () => new Promise(() => {}) },
    webNavigation: { getAllFrames: async () => [top, loaded] },
  };
  const started = Date.now();
  await framesSettled(api, 1);
  assert.ok(Date.now() - started < 1100, `framesSettled took ${Date.now() - started} ms`);
});

test("framesSettled does not wait for a child frame that stays blank", async () => {
  let calls = 0;
  const api = {
    tabs: { executeScript: async () => [[1, 0]], sendMessage: answers },
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

test("navigate waits for the page load when the process-switch abort arrives while the tab already reads complete", async () => {
  const url = "http://a.test/frames.html";
  const listeners = {};
  const event = (name) => {
    listeners[name] = new Set();
    return { addListener: (l) => listeners[name].add(l), removeListener: (l) => listeners[name].delete(l) };
  };
  const fire = (name, details) => { for (const l of [...listeners[name]]) l({ tabId: 1, frameId: 0, url, ...details }); };
  const api = {
    webNavigation: {
      onBeforeNavigate: event("before"), onCompleted: event("completed"), onErrorOccurred: event("error"),
      onHistoryStateUpdated: event("history"), onReferenceFragmentUpdated: event("fragment"),
    },
    tabs: {
      // The order Firefox reported on Windows: the page commits, then the new tab's about:blank load finishes late,
      // then the load that the process switch aborted is reported.
      update: async () => {
        fire("before");
        fire("completed", { url: "about:blank" });
        fire("before");
        fire("error", { error: "Error code 2152398850" });
      },
      get: async () => ({ id: 1, url, title: "Frames", status: "complete" }),
      executeScript: async () => [[0, 0]],
    },
  };
  let returned = false;
  const result = tabTools({ api }).navigate.run({ tab: { id: 1 }, args: { url } }).finally(() => { returned = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(returned, false);
  fire("completed");
  assert.equal(await result, `Navigated to ${url} — "Frames"`);
});

test("withScheme prefixes https to scheme-less URLs including host:port and keeps real schemes", () => {
  for (const url of ["localhost:3000", "example.com:8080/path", "example.com", "127.0.0.1:8080"]) assert.equal(withScheme(url), `https://${url}`);
  for (const url of ["http://a.test", "HTTPS://a.test", "ftp://a.test", "about:blank", "data:text/html,hi", "javascript:void 0", "view-source:https://a.test", "moz-extension://id/page.html", "file:///tmp/a.html"]) assert.equal(withScheme(url), url);
});
