import test from "node:test";
import assert from "node:assert/strict";
import { STOPPED_MESSAGE, createControl } from "../../extension/background/control.js";
import { createSessions } from "../../extension/background/sessions.js";

function fakeSessions() {
  const stopped = new Set();
  const statuses = [];
  const sessions = {
    isStopped: async (id) => stopped.has(id),
    setStopped: async (id, value) => { if (value) stopped.add(id); else stopped.delete(id); },
    setStatus: async (id, status) => { statuses.push([id, status]); },
  };
  return { sessions, statuses };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("calls get a live abort signal and mark the session busy, then idle", async () => {
  const { sessions, statuses } = fakeSessions();
  const control = createControl({ sessions, idleAfterMs: 5 });
  let seen;
  assert.equal(await control.run("s", async (signal) => { seen = signal; return "ok"; }), "ok");
  assert.equal(seen.aborted, false);
  await sleep(20);
  assert.deepEqual(statuses, [["s", "busy"], ["s", "idle"]]);
});

test("Stop rejects the running call at once and aborts its signal", async () => {
  const { sessions } = fakeSessions();
  const changes = [];
  const control = createControl({ sessions, onChange: async (id) => { changes.push(id); }, idleAfterMs: 5 });
  let signal;
  const running = control.run("s", (s) => { signal = s; return new Promise(() => {}); });
  await tick();
  await control.stop("s");
  await assert.rejects(running, { message: STOPPED_MESSAGE });
  assert.equal(signal.aborted, true);
  assert.deepEqual(changes, ["s"]);
});

test("a stopped session refuses calls until Resume, and other sessions are unaffected", async () => {
  const { sessions } = fakeSessions();
  const control = createControl({ sessions, idleAfterMs: 5 });
  await control.stop("s");
  await assert.rejects(control.run("s", async () => "no"), { message: STOPPED_MESSAGE });
  assert.equal(await control.run("other", async () => "yes"), "yes");
  await control.resume("s");
  let seen;
  assert.equal(await control.run("s", async (signal) => { seen = signal; return "again"; }), "again");
  assert.equal(seen.aborted, false);
});

test("Stop takes effect before the slow persist finishes", async () => {
  const { sessions } = fakeSessions();
  const persisted = sessions.setStopped;
  sessions.setStopped = async (id, value) => { await sleep(30); return persisted(id, value); };
  const control = createControl({ sessions, idleAfterMs: 5 });
  const stopping = control.stop("s");
  await assert.rejects(control.run("s", async () => "no"), { message: STOPPED_MESSAGE });
  await stopping;
});

test("Stop that lands while a call looks up the stopped state still refuses the call", async () => {
  const { sessions } = fakeSessions();
  const lookup = sessions.isStopped;
  sessions.isStopped = async (id) => {
    const value = await lookup(id);
    await sleep(20);
    return value;
  };
  const control = createControl({ sessions, idleAfterMs: 5 });
  let ran = false;
  const call = control.run("s", async () => { ran = true; return "delivered"; });
  await sleep(1);
  await control.stop("s");
  await assert.rejects(call, { message: STOPPED_MESSAGE });
  assert.equal(ran, false);
});

test("close closes the session, aborts running calls and reports the tabs that left it", async () => {
  const { sessions } = fakeSessions();
  sessions.close = async () => [{ id: 1 }];
  let reported;
  const control = createControl({ sessions, onClosed: async (tabs) => { reported = tabs; }, idleAfterMs: 5 });
  const running = control.run("s", () => new Promise(() => {}));
  await tick();
  await control.close("s");
  await assert.rejects(running, { message: STOPPED_MESSAGE });
  assert.deepEqual(reported, [{ id: 1 }]);
});

function fakeApi() {
  let nextTab = 1;
  let nextWindow = 10;
  let nextGroup = 100;
  const tabs = new Map();
  const windows = new Map();
  const groups = new Map();
  const values = new Map();
  const counts = { getAll: 0 };
  const copy = (t) => ({ ...t });
  const addTab = (props) => {
    const t = { id: nextTab++, title: "", groupId: -1, active: false, ...props };
    tabs.set(t.id, t);
    return t;
  };
  const addWindow = (props = {}) => {
    const id = nextWindow++;
    windows.set(id, { id, titlePreface: "", ...props });
    return id;
  };
  const api = {
    windows: {
      create: async ({ url, focused }) => {
        const id = addWindow({ focused });
        return { id, tabs: [copy(addTab({ windowId: id, url, active: true }))] };
      },
      get: async (id) => {
        if (!windows.has(id)) throw new Error(`Invalid window ID: ${id}`);
        return { ...windows.get(id) };
      },
      getAll: async () => { counts.getAll++; return [...windows.values()].map((w) => ({ ...w })); },
      getLastFocused: async () => {
        const win = [...windows.values()].find((w) => w.focused) ?? [...windows.values()].at(-1);
        if (!win) throw new Error("Invalid window");
        return { ...win };
      },
      update: async (id, props) => { Object.assign(windows.get(id), props); },
    },
    sessions: {
      setWindowValue: async (id, key, value) => { values.set(`${id}:${key}`, structuredClone(value)); },
      getWindowValue: async (id, key) => structuredClone(values.get(`${id}:${key}`)),
      removeWindowValue: async (id, key) => { values.delete(`${id}:${key}`); },
    },
    tabs: {
      create: async ({ windowId, url, active = true, openerTabId }) => copy(addTab({ windowId, url, active, openerTabId })),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error(`Invalid tab ID: ${id}`);
        return copy(tabs.get(id));
      },
      query: async ({ windowId }) => [...tabs.values()].filter((t) => t.windowId === windowId).map(copy),
      group: async ({ tabIds, groupId }) => {
        const ids = [].concat(tabIds);
        const id = groupId ?? nextGroup++;
        if (!groups.has(id)) groups.set(id, { title: "", color: "", windowId: tabs.get(ids[0]).windowId });
        for (const tabId of ids) tabs.get(tabId).groupId = id;
        return id;
      },
      update: async (id, props) => { Object.assign(tabs.get(id), props); },
    },
    tabGroups: {
      update: async (id, props) => { Object.assign(groups.get(id), props); },
      query: async ({ windowId }) => [...groups.entries()].filter(([, g]) => g.windowId === windowId).map(([id, g]) => ({ id, ...g })),
    },
  };
  const closeWindow = (id) => {
    windows.delete(id);
    for (const t of [...tabs.values()]) if (t.windowId === id) tabs.delete(t.id);
  };
  return { api, counts, tabs, windows, groups, values, addTab, addWindow, closeWindow };
}

test("closing the main window of a stopped session lets the next call start a fresh one", async () => {
  const { api, closeWindow } = fakeApi();
  const sessions = createSessions(api);
  const control = createControl({ sessions, idleAfterMs: 5 });
  const id = "abcd1234-0000-4000-8000-000000000000";
  const first = await control.run(id, () => sessions.context(id, { createIfEmpty: true }));
  await control.stop(id);
  closeWindow(first.windowId);
  sessions.windowRemoved(first.windowId);
  const again = await control.run(id, () => sessions.context(id, { createIfEmpty: true }));
  assert.notEqual(again.windowId, first.windowId);
});
