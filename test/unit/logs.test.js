import test from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
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

const stackTrace = ["TypeError: cart is undefined (https://shop.test/static/js/main.3f2a1b9c.js:3:7)", ...Array.from({ length: 10 }, (_, i) => `    dispatchDiscreteEvent${i}@https://cdn.shop.test/static/js/vendors-node_modules_react-dom_cjs_react-dom_development_js.3f2a1b9c.chunk.js:${i + 1}:${10_000 + i}`)].join("\n");
const longUrl = `https://shop.test/search?${"filter=colour%3Ablue&".repeat(80)}`;

test("a huge console message and page URL are stored truncated with a marker, and a stack trace and a long URL are kept whole", () => {
  const store = createLogStore();
  store.committed(1, "https://shop.test/");
  store.addConsole(1, [
    { level: "error", text: stackTrace, url: longUrl, time: 0 },
    { level: "log", text: "x".repeat(1_000_000), url: `https://shop.test/?${"y".repeat(1_000_000)}`, time: 0 },
  ]);
  const [ordinary, huge] = store.readConsole(1).split(/\n(?=\[\d+\] )/).slice(1);
  assert.match(ordinary, /^\[1\] \[[\d:]+\] \[ERROR\] /);
  assert.equal(ordinary.replace(/^\[1\] \[[\d:]+\] \[ERROR\] /, ""), `(${longUrl}) ${stackTrace}`);
  assert.match(huge, /^\[2\] \[[\d:]+\] \[LOG\] \(https:\/\/shop\.test\/\?y+…\[truncated\]\) x+…\[truncated\]$/);
  assert.ok(huge.length < 10_000, `the stored message is ${huge.length} characters`);
});

test("a huge request URL is stored truncated with a marker and a long one is kept whole", () => {
  const store = createLogStore();
  store.requestStarted(1, { requestId: "1", method: "GET", url: longUrl, type: "xmlhttprequest" });
  store.requestStarted(1, { requestId: "2", method: "GET", url: `https://shop.test/?${"z".repeat(1_000_000)}`, type: "image" });
  const [ordinary, huge] = store.readNetwork(1).split("\n\n")[1].split(/\n(?=\d+\. url: )/);
  assert.equal(ordinary, `1. url: ${longUrl}\n   method: GET\n   statusCode: pending`);
  assert.match(huge, /^2\. url: https:\/\/shop\.test\/\?z+…\[truncated\]\n/);
  assert.ok(huge.length < 10_000, `the stored request is ${huge.length} characters`);
});

test("truncated console messages and request URLs do not keep the full strings alive", () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  const store = createLogStore();
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 500; i++) {
    store.addConsole(1, [{ level: "log", text: "x".repeat(100_000) + i, url: `https://shop.test/?${"y".repeat(100_000)}${i}`, time: 0 }]);
    store.requestStarted(1, { requestId: String(i), method: "GET", url: `https://shop.test/?${"z".repeat(100_000)}${i}`, type: "image" });
  }
  gc();
  const retainedMB = (process.memoryUsage().heapUsed - before) / 1e6;
  assert.ok(retainedMB < 30, `${retainedMB.toFixed(1)} MB retained for 1500 strings of about 2000 characters`);
});
