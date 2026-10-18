import test from "node:test";
import assert from "node:assert/strict";
import { framesSettled, watchNavigation } from "../../extension/background/navigation.js";

function fakeApi({ tab = { id: 1, url: "https://b.test/", title: "B", status: "complete" } } = {}) {
  const listeners = {};
  const event = (name) => {
    listeners[name] = new Set();
    return { addListener: (l) => listeners[name].add(l), removeListener: (l) => listeners[name].delete(l) };
  };
  const api = {
    webNavigation: {
      onBeforeNavigate: event("before"), onCommitted: event("committed"), onCompleted: event("completed"), onErrorOccurred: event("error"),
      onHistoryStateUpdated: event("history"), onReferenceFragmentUpdated: event("fragment"),
      getAllFrames: async () => [],
    },
    tabs: {
      get: async (id) => {
        if (closed) throw new Error(`Invalid tab ID: ${id}`);
        return tab;
      },
      executeScript: async () => [[0, 0]],
      onRemoved: event("removed"),
    },
  };
  let closed = false;
  const fire = (name, details) => { for (const l of [...listeners[name]]) l({ tabId: 1, frameId: 0, ...details }); };
  const close = (tabId = 1) => {
    if (tabId === 1) closed = true;
    for (const l of [...listeners.removed]) l(tabId, { windowId: 5, isWindowClosing: false });
  };
  const live = () => Object.values(listeners).reduce((n, set) => n + set.size, 0);
  return { api, fire, close, live };
}

test("no navigation within the start window settles with no suffix and stops listening", async () => {
  const { api, live } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 20 });
  assert.equal(await watch.settle(), "");
  assert.equal(live(), 0);
});

test("a load that starts and completes reports the final URL and title", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50 });
  fire("before", { url: "https://b.test/" });
  fire("committed", { url: "https://b.test/" });
  setTimeout(() => fire("completed", { url: "https://b.test/" }), 5);
  assert.equal(await watch.settle(), '→ Navigated to https://b.test/ — "B"');
});

test("a load that completes without committing a document, as a download does, settles without waiting for the tab to show it", async () => {
  const { api, fire, live } = fakeApi({ tab: { id: 1, url: "https://a.test/page", title: "A", status: "complete" } });
  const watch = watchNavigation(api, 1, { startMs: 50 });
  fire("before", { url: "https://a.test/export" });
  fire("completed", { url: "https://a.test/export" });
  const started = Date.now();
  assert.equal(await watch.settle(), "");
  assert.ok(Date.now() - started < 500, `settle took ${Date.now() - started} ms`);
  assert.equal(live(), 0);
});

test("a process-switch abort is not the end of the load", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50, loadMs: 30 });
  fire("before", { url: "https://b.test/" });
  fire("error", { url: "https://b.test/", error: "Error code 2152398850" });
  assert.equal(await watch.settle(), "→ Still loading after 0.03s: https://b.test/");
});

test("a real load error ends the wait", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50, loadMs: 30 });
  fire("before", { url: "https://b.test/" });
  fire("error", { url: "https://b.test/", error: "Error code 2152398878" });
  assert.equal(await watch.settle(), '→ Navigated to https://b.test/ — "B"');
});

test("events from other frames and about:blank do not count", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 30 });
  fire("before", { url: "https://b.test/", frameId: 4 });
  fire("before", { url: "about:blank" });
  assert.equal(await watch.settle(), "");
});

test("same-document changes are reported without waiting for a load", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50 });
  fire("history", { url: "https://a.test/next" });
  assert.equal(await watch.settle(), "→ URL changed to https://a.test/next");
});

test("a load that does not finish in time is reported as still loading", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50, loadMs: 20 });
  fire("before", { url: "https://slow.test/" });
  assert.equal(await watch.settle(), "→ Still loading after 0.02s: https://slow.test/");
});

test("an abort signal ends the wait early", async () => {
  const { api, fire } = fakeApi();
  const controller = new AbortController();
  const watch = watchNavigation(api, 1, { signal: controller.signal, startMs: 50, loadMs: 60_000 });
  fire("before", { url: "https://slow.test/" });
  setTimeout(() => controller.abort(), 5);
  const started = Date.now();
  await watch.settle();
  assert.ok(Date.now() - started < 1000);
});

test("a tab that closes after its load finished reports that it closed", async () => {
  const { api, fire, close, live } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50 });
  fire("before", { url: "https://b.test/" });
  fire("completed", { url: "https://b.test/" });
  close();
  assert.equal(await watch.settle(), "→ The tab closed");
  assert.equal(live(), 0);
});

test("a tab that closes while its load is in flight ends the wait", async () => {
  const { api, fire, close } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50, loadMs: 60_000 });
  fire("before", { url: "https://b.test/" });
  setTimeout(() => { close(2); close(); }, 5);
  const started = Date.now();
  assert.equal(await watch.settle(), "→ The tab closed");
  assert.ok(Date.now() - started < 1000);
});

test("a tab that closes itself without navigating reports that it closed", async () => {
  const { api, close } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50 });
  close();
  assert.equal(await watch.settle(), "→ The tab closed");
});

test("framesSettled waits until the child frame is registered", async () => {
  const polls = [[{ frameId: 0, parentFrameId: -1 }], [{ frameId: 0, parentFrameId: -1 }, { frameId: 7, parentFrameId: 0 }]];
  let calls = 0;
  const api = { tabs: { executeScript: async () => [[1, 1]], sendMessage: async () => ({}) }, webNavigation: { getAllFrames: async () => polls[Math.min(calls++, polls.length - 1)] } };
  await framesSettled(api, 1);
  assert.equal(calls, 2);
});
