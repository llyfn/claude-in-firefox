import test from "node:test";
import assert from "node:assert/strict";
import { createLogStore, installLogListeners } from "../../extension/background/logs.js";

const message = (level, text) => ({ level, text, url: "u", time: 0 });

test("console messages filter by level and pattern and keep the newest on overflow", () => {
  const store = createLogStore({ maxConsole: 3 });
  store.committed(1, "https://a.test/");
  store.addConsole(1, [message("log", "one"), message("error", "Boom two"), message("warn", "three"), message("log", "four")]);
  const all = store.readConsole(1);
  assert.match(all, /^Found 3 console message\(s\):/);
  assert.doesNotMatch(all, /\bone\b/);
  assert.match(store.readConsole(1, { onlyErrors: true }), /\[ERROR\] \(u\) Boom two/);
  assert.match(store.readConsole(1, { pattern: "^four$" }), /^Found 1 /);
  assert.match(store.readConsole(1, { pattern: "([" }), /No console messages found matching "\(\["/);
  assert.match(store.readConsole(1, { limit: 1 }), /showing the last 1/);
});

test("console buffers reset on a new origin and clear empties them", () => {
  const store = createLogStore();
  store.committed(1, "https://a.test/x");
  store.addConsole(1, [message("log", "first page")]);
  store.committed(1, "https://a.test/y");
  assert.match(store.readConsole(1), /first page/);
  store.committed(1, "https://b.test/");
  assert.match(store.readConsole(1), /^No console messages found\.$/);
  store.addConsole(1, [message("log", "second page")]);
  assert.match(store.readConsole(1, { clear: true }), /second page/);
  assert.match(store.readConsole(1), /^No console messages found\.$/);
});

test("network requests are listed with status and reset on a new top-level origin", () => {
  const store = createLogStore();
  store.requestStarted(1, { requestId: "1", method: "GET", url: "https://a.test/", type: "main_frame" });
  store.requestStarted(1, { requestId: "2", method: "POST", url: "https://a.test/api/save", type: "xmlhttprequest" });
  store.requestFinished(1, "1", "200");
  store.requestFinished(1, "2", "failed (NS_ERROR_NET_RESET)");
  assert.equal(store.readNetwork(1, { urlPattern: "/api/" }), "Found 1 request(s):\n\n1. url: https://a.test/api/save\n   method: POST\n   statusCode: failed (NS_ERROR_NET_RESET)");
  store.requestStarted(1, { requestId: "3", method: "GET", url: "https://b.test/", type: "main_frame" });
  assert.equal(store.readNetwork(1), "Found 1 request(s):\n\n1. url: https://b.test/\n   method: GET\n   statusCode: pending");
});

function listenedStore() {
  const listeners = {};
  const event = (name) => ({ addListener: (listener) => { listeners[name] = listener; } });
  const api = {
    webRequest: { onBeforeRequest: event("request"), onCompleted: event("requestDone"), onErrorOccurred: event("requestFailed") },
    webNavigation: { onCommitted: event("committed") },
    tabs: { onRemoved: event("removed") },
    runtime: { onMessage: event("message") },
  };
  const store = createLogStore();
  installLogListeners(api, store);
  return {
    store,
    commit: (url) => listeners.committed({ tabId: 1, frameId: 0, url }),
    log: (text) => listeners.message({ type: "console", entries: [message("log", text)] }, { tab: { id: 1 }, frameId: 0 }),
  };
}

test("a new tab's about:blank commit reported after the page it navigated to has logged keeps that page's messages", () => {
  const { store, commit, log } = listenedStore();
  commit("http://127.0.0.1:8000/console.html");
  log("page loaded 42");
  commit("about:blank");
  assert.match(store.readConsole(1), /page loaded 42/);
});

test("a top-level commit of another origin still starts a fresh console buffer", () => {
  const { store, commit, log } = listenedStore();
  commit("https://a.test/");
  log("first page");
  commit("https://b.test/");
  assert.match(store.readConsole(1), /^No console messages found\.$/);
});
