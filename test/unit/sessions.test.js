import test from "node:test";
import assert from "node:assert/strict";
import { NO_SESSION_MESSAGE, createSessions } from "../../extension/background/sessions.js";

function fakeApi({ groups: groupsEnabled = true, noGroupApi = false } = {}) {
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
        if (!groupsEnabled) throw new Error("Tab groups are disabled");
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
  if (noGroupApi) {
    delete api.tabs.group;
    delete api.tabGroups;
  }
  const closeWindow = (id) => {
    windows.delete(id);
    for (const t of [...tabs.values()]) if (t.windowId === id) tabs.delete(t.id);
  };
  return { api, counts, tabs, windows, groups, values, addTab, addWindow, closeWindow };
}

const ID = "abcd1234-0000-4000-8000-000000000000";

test("context is null until the window is created on request", async () => {
  const sessions = createSessions(fakeApi().api);
  assert.equal(await sessions.context(ID), null);
});

test("createIfEmpty opens one unfocused window with a blank tab, labelled and remembered on the window", async () => {
  const { api, windows, groups, values } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  assert.deepEqual(ctx, { availableTabs: [{ tabId: 1, title: "", url: "about:blank" }], windowId: 10 });
  assert.equal(windows.get(10).focused, false);
  assert.equal(windows.get(10).titlePreface, "Claude · abcd1234 — ");
  assert.deepEqual([...groups.values()].map((g) => [g.title, g.color]), [["Claude · abcd1234", "orange"]]);
  assert.deepEqual(values.get("10:claudeSession"), { sessionId: ID, role: "main", stopped: false });
  assert.equal((await sessions.context(ID, { createIfEmpty: true })).availableTabs.length, 1);
  assert.equal(windows.size, 1);
});

test("creating a session gives focus back to the Firefox window the user was in, and leaves focus alone when none had it", async () => {
  for (const userFocused of [true, false]) {
    const { api, addWindow } = fakeApi();
    const user = addWindow({ focused: userFocused });
    const focusCalls = [];
    const update = api.windows.update;
    api.windows.update = async (id, props) => {
      if ("focused" in props) focusCalls.push([id, props.focused]);
      return update(id, props);
    };
    await createSessions(api).context(ID, { createIfEmpty: true });
    assert.deepEqual(focusCalls, userFocused ? [[user, true]] : []);
  }
});

test("concurrent createIfEmpty calls open only one window", async () => {
  const { api, windows } = fakeApi();
  const sessions = createSessions(api);
  const [a, b] = await Promise.all([sessions.context(ID, { createIfEmpty: true }), sessions.context(ID, { createIfEmpty: true })]);
  assert.equal(a.windowId, b.windowId);
  assert.equal(windows.size, 1);
});

test("sessions work when tab groups are disabled", async () => {
  const { api, windows } = fakeApi({ groups: false });
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  assert.equal(windows.get(ctx.windowId).titlePreface, "Claude · abcd1234 — ");
  const tab = await sessions.createTab(ID);
  assert.equal((await sessions.ownedTab(ID, tab.id)).id, tab.id);
});

test("ownedTab accepts any tab in the session's window and rejects others with the valid IDs", async () => {
  const { api, addTab, addWindow } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const userAdded = addTab({ windowId: ctx.windowId, url: "https://mine.test/" });
  const stranger = addTab({ windowId: addWindow(), url: "https://other.test/" });
  assert.equal((await sessions.ownedTab(ID, userAdded.id)).id, userAdded.id);
  await assert.rejects(sessions.ownedTab(ID, stranger.id), { message: `Tab ${stranger.id} is not in this session's window. Valid tab IDs: 1, ${userAdded.id}` });
  await assert.rejects(sessions.ownedTab(ID, 999), /Tab 999 is not in this session's window/);
});

test("calls before a window exists explain how to create one", async () => {
  const sessions = createSessions(fakeApi().api);
  await assert.rejects(sessions.ownedTab(ID, 1), { message: NO_SESSION_MESSAGE });
  await assert.rejects(sessions.createTab(ID), { message: NO_SESSION_MESSAGE });
});

test("createTab opens an active tab in the session's window and group", async () => {
  const { api, tabs } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const tab = await sessions.createTab(ID);
  assert.equal(tab.windowId, ctx.windowId);
  assert.equal(tab.active, true);
  assert.equal(tabs.get(tab.id).groupId, tabs.get(1).groupId);
});

test("activate makes an inactive tab the active tab of its window", async () => {
  const { api, tabs } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const other = await api.tabs.create({ windowId: ctx.windowId, url: "https://x.test/", active: false });
  await sessions.activate(other);
  assert.equal(tabs.get(other.id).active, true);
});

test("closing the main window forgets the session", async () => {
  const { api, closeWindow } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  closeWindow(ctx.windowId);
  sessions.windowRemoved(ctx.windowId);
  assert.equal(await sessions.context(ID), null);
  await assert.rejects(sessions.ownedTab(ID, 1), { message: NO_SESSION_MESSAGE });
  const again = await sessions.context(ID, { createIfEmpty: true });
  assert.notEqual(again.windowId, ctx.windowId);
});

test("a reloaded background recovers the session, its stop state and its group from window values", async () => {
  const { api, tabs } = fakeApi();
  const first = createSessions(api);
  const ctx = await first.context(ID, { createIfEmpty: true });
  await first.setStopped(ID, true);
  const second = createSessions(api);
  assert.deepEqual((await second.context(ID)).windowId, ctx.windowId);
  assert.equal(await second.isStopped(ID), true);
  const tab = await second.createTab(ID);
  assert.equal(tabs.get(tab.id).groupId, tabs.get(1).groupId);
  assert.equal(await second.sessionOfTab(tabs.get(1)), ID);
});

test("popup windows opened from a session tab join the session, and other tabs are left alone", async () => {
  const { api, addTab, addWindow, values } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const popupWindow = addWindow({ type: "popup" });
  const popup = addTab({ windowId: popupWindow, url: "https://login.test/", openerTabId: 1 });
  await sessions.adoptOpened(popup);
  assert.equal((await sessions.ownedTab(ID, popup.id)).id, popup.id);
  assert.deepEqual(values.get(`${popupWindow}:claudeSession`), { sessionId: ID, role: "popup", stopped: false });
  const userWindow = addWindow();
  addTab({ windowId: userWindow, url: "https://mine.test/" });
  const strayed = addTab({ windowId: userWindow, url: "https://x.test/", openerTabId: 1 });
  await sessions.adoptOpened(strayed);
  await assert.rejects(sessions.ownedTab(ID, strayed.id), /is not in this session's window/);
  const outsider = addTab({ windowId: userWindow, url: "https://y.test/" });
  const child = addTab({ windowId: ctx.windowId + 100, url: "https://z.test/", openerTabId: outsider.id });
  await sessions.adoptOpened(child);
  assert.equal(await sessions.sessionOfTab(child), null);
});

test("tabs opened in the session's window from a session tab join its group", async () => {
  const { api, addTab, tabs } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const child = addTab({ windowId: ctx.windowId, url: "https://x.test/", openerTabId: 1 });
  await sessions.adoptOpened(child);
  assert.equal(tabs.get(child.id).groupId, tabs.get(1).groupId);
});

test("status and stop state change the label, and a stopped session keeps the stopped label", async () => {
  const { api, windows, groups, values } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const group = () => [...groups.values()][0].title;
  await sessions.setStatus(ID, "busy");
  assert.equal(group(), "⌛ Claude · abcd1234");
  assert.equal(windows.get(ctx.windowId).titlePreface, "⌛ Claude · abcd1234 — ");
  await sessions.setStopped(ID, true);
  assert.equal(group(), "⏸ Claude · abcd1234");
  assert.equal(values.get(`${ctx.windowId}:claudeSession`).stopped, true);
  await sessions.setStatus(ID, "idle");
  assert.equal(group(), "⏸ Claude · abcd1234");
  await sessions.setStopped(ID, false);
  assert.equal(group(), "✅ Claude · abcd1234");
});

test("tab changes since the last report are described once", async () => {
  const { api, addTab, tabs } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  assert.equal(await sessions.tabChanges(ID), "");
  const opened = addTab({ windowId: ctx.windowId, url: "https://x.test/", title: "X" });
  tabs.delete(1);
  assert.equal(await sessions.tabChanges(ID), `Tabs changed: opened ${opened.id} "X" https://x.test/; closed 1`);
  assert.equal(await sessions.tabChanges(ID), "");
});

test("close forgets the session and clears its window values", async () => {
  const { api, values } = fakeApi();
  const sessions = createSessions(api);
  await sessions.context(ID, { createIfEmpty: true });
  await sessions.close(ID);
  assert.equal(values.size, 0);
  assert.equal(await sessions.context(ID), null);
});

test("a call racing the first lookup after a reload sees the recovered stop state", async () => {
  const { api } = fakeApi();
  await createSessions(api).context(ID, { createIfEmpty: true });
  const second = createSessions(api);
  await Promise.all([second.setStopped(ID, true), second.isStopped(ID)]);
  assert.equal(await second.isStopped(ID), true);
});

test("parallel lookups after a reload share one recovery scan", async () => {
  const { api, counts } = fakeApi();
  const ctx = await createSessions(api).context(ID, { createIfEmpty: true });
  const second = createSessions(api);
  counts.getAll = 0;
  const [a, b] = await Promise.all([second.context(ID), second.context(ID)]);
  assert.equal(a.windowId, ctx.windowId);
  assert.equal(b.windowId, ctx.windowId);
  assert.equal(counts.getAll, 1);
});

test("recovery keeps the existing group color", async () => {
  const { api, groups } = fakeApi();
  await createSessions(api).context(ID, { createIfEmpty: true });
  [...groups.values()][0].color = "red";
  const second = createSessions(api);
  await second.context(ID);
  await second.setStatus(ID, "busy");
  assert.equal([...groups.values()][0].color, "red");
});

test("a failing window value save does not leave the session half-built", async () => {
  const { api, windows } = fakeApi();
  api.sessions.setWindowValue = async () => { throw new Error("nope"); };
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  assert.equal(windows.get(ctx.windowId).titlePreface, "Claude · abcd1234 — ");
});

test("closing the main window also clears the popup windows' values", async () => {
  const { api, addTab, addWindow, closeWindow, values } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const popupWindow = addWindow({ type: "popup" });
  await sessions.adoptOpened(addTab({ windowId: popupWindow, url: "https://login.test/", openerTabId: 1 }));
  closeWindow(ctx.windowId);
  sessions.windowRemoved(ctx.windowId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(values.has(`${popupWindow}:claudeSession`), false);
});

test("closing a popup window leaves the session in place", async () => {
  const { api, counts, addTab, addWindow, closeWindow } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const popupWindow = addWindow({ type: "popup" });
  await sessions.adoptOpened(addTab({ windowId: popupWindow, url: "https://login.test/", openerTabId: 1 }));
  closeWindow(popupWindow);
  sessions.windowRemoved(popupWindow);
  counts.getAll = 0;
  assert.equal((await sessions.context(ID)).windowId, ctx.windowId);
  assert.equal(counts.getAll, 0);
});

test("sessions work when the tab group APIs are missing entirely", async () => {
  const { api } = fakeApi({ noGroupApi: true });
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const tab = await sessions.createTab(ID);
  await sessions.setStatus(ID, "busy");
  assert.equal((await sessions.ownedTab(ID, tab.id)).windowId, ctx.windowId);
  assert.equal((await createSessions(api).context(ID)).windowId, ctx.windowId);
});
