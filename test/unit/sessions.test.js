import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createPresence } from "../../extension/background/presence.js";
import { NEEDS_GROUPS_MESSAGE, NO_SESSION_MESSAGE, createSessions } from "../../extension/background/sessions.js";

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
        if (groupId != null && !groups.has(groupId)) throw new Error(`No group with id: ${groupId}`);
        const id = groupId ?? nextGroup++;
        if (!groups.has(id)) groups.set(id, { title: "", color: "", windowId: tabs.get(ids[0]).windowId });
        for (const tabId of ids) tabs.get(tabId).groupId = id;
        return id;
      },
      ungroup: async (tabIds) => { for (const id of [].concat(tabIds)) tabs.get(id).groupId = -1; },
      remove: async (tabIds) => { for (const id of [].concat(tabIds)) tabs.delete(id); },
      update: async (id, props) => { Object.assign(tabs.get(id), props); },
    },
    tabGroups: {
      get: async (id) => {
        if (!groups.has(id)) throw new Error(`No group with id: ${id}`);
        return { id, ...groups.get(id) };
      },
      update: async (id, props) => { Object.assign(groups.get(id), props); },
      query: async ({ windowId }) => [...groups.entries()].filter(([, g]) => g.windowId === windowId).map(([id, g]) => ({ id, ...g })),
    },
  };
  if (noGroupApi) {
    delete api.tabs.group;
    delete api.tabs.ungroup;
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
  assert.equal(windows.get(10).titlePreface, "Claude · abcd — ");
  assert.deepEqual([...groups.values()].map((g) => [g.title, g.color]), [["Claude · abcd", "orange"]]);
  assert.deepEqual(values.get("10:claudeSession"), { sessionId: ID, role: "main", stopped: false, groupId: 100 });
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

test("sessions created in parallel leave focus on the user's window", async () => {
  const { api, windows, addWindow } = fakeApi();
  const user = addWindow({ focused: true });
  const focus = (id) => { for (const w of windows.values()) w.focused = w.id === id; };
  let release;
  const focusApplied = new Promise((resolve) => { release = resolve; });
  const { create, update } = api.windows;
  // Firefox focuses every new window, and a requested focus change lands later.
  api.windows.create = async (props) => {
    const win = await create(props);
    focus(win.id);
    return win;
  };
  api.windows.update = async (id, { focused, ...props }) => {
    if (focused) await focusApplied.then(() => focus(id));
    return update(id, props);
  };
  const ticks = async (n) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const sessions = createSessions(api);
  const first = sessions.context(ID, { createIfEmpty: true });
  while (windows.size < 2) await ticks(1);
  const second = sessions.context("efgh5678-0000-4000-8000-000000000000", { createIfEmpty: true });
  await ticks(10);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a.windowId, b.windowId);
  assert.deepEqual([...windows.values()].filter((w) => w.focused).map((w) => w.id), [user]);
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
  assert.equal(windows.get(ctx.windowId).titlePreface, "Claude · abcd — ");
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

test("sharesUserWindow is false for a session with its own window", async () => {
  const { api, tabs } = fakeApi();
  const sessions = createSessions(api);
  await sessions.context(ID, { createIfEmpty: true });
  assert.equal(await sessions.sharesUserWindow(tabs.get(1)), false);
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
  assert.deepEqual(values.get(`${popupWindow}:claudeSession`), { sessionId: ID, role: "popup", stopped: false, groupId: 100 });
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
  assert.equal(group(), "Claude · abcd · working");
  assert.equal(windows.get(ctx.windowId).titlePreface, "Claude · abcd · working — ");
  await sessions.setStopped(ID, true);
  assert.equal(group(), "Claude · abcd · stopped");
  assert.equal(values.get(`${ctx.windowId}:claudeSession`).stopped, true);
  await sessions.setStatus(ID, "idle");
  assert.equal(group(), "Claude · abcd · stopped");
  await sessions.setStopped(ID, false);
  assert.equal(group(), "Claude · abcd");
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
  assert.equal(windows.get(ctx.windowId).titlePreface, "Claude · abcd — ");
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

test("a restored window of a session no call has touched shows no pill and leaves dialogs native until a call arrives", async () => {
  const { api, addTab } = fakeApi();
  const ctx = await createSessions(api).context(ID, { createIfEmpty: true });
  const restarted = createSessions(api);
  const presence = createPresence({ api, content: { call: async () => {} }, sessions: restarted });
  const userTab = addTab({ windowId: ctx.windowId, url: "https://bank.test/" });
  assert.equal(await presence.stateFor(userTab), null);
  assert.equal(await presence.dialogsEnabled(userTab), false);
  await restarted.context(ID);
  assert.equal(await presence.stateFor(userTab), "active");
  assert.equal(await presence.dialogsEnabled(userTab), true);
});

test("a window carrying a session's value but not in its record belongs to no session", async () => {
  const { api, addTab, addWindow, values } = fakeApi();
  const sessions = createSessions(api);
  const presence = createPresence({ api, content: { call: async () => {} }, sessions });
  const old = await sessions.context(ID, { createIfEmpty: true });
  sessions.windowRemoved(old.windowId);
  await sessions.context(ID, { createIfEmpty: true });
  const reopened = addWindow();
  values.set(`${reopened}:claudeSession`, { sessionId: ID, role: "main", stopped: false });
  const tab = addTab({ windowId: reopened, url: "https://x.test/" });
  assert.equal(await sessions.sessionOfTab(tab), null);
  assert.equal(await presence.stateFor(tab), null);
});

test("onLoaded fires once when a call creates the session and once when a reloaded background recovers it", async () => {
  const { api } = fakeApi();
  const loaded = [];
  const first = createSessions(api, { onLoaded: (id) => loaded.push(["first", id]) });
  await first.context(ID, { createIfEmpty: true });
  await first.context(ID);
  const second = createSessions(api, { onLoaded: (id) => loaded.push(["second", id]) });
  await Promise.all([second.isStopped(ID), second.context(ID)]);
  await second.ownedTab(ID, 1);
  assert.deepEqual(loaded, [["first", ID], ["second", ID]]);
});

test("closing a session while its window is being created closes the new window's session too", async () => {
  const { api, values, windows } = fakeApi();
  const create = api.windows.create;
  api.windows.create = async (props) => { await new Promise((resolve) => setTimeout(resolve, 20)); return create(props); };
  const sessions = createSessions(api);
  const opening = sessions.context(ID, { createIfEmpty: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const left = await sessions.close(ID);
  const ctx = await opening;
  assert.deepEqual(left.map((t) => t.id), [1]);
  assert.equal(values.size, 0);
  assert.equal(await sessions.sessionOfTab({ windowId: ctx.windowId }), null);
  assert.equal(windows.get(ctx.windowId).titlePreface, "");
});

test("closing a session while a call recovers it leaves nothing behind", async () => {
  const { api, values } = fakeApi();
  const ctx = await createSessions(api).context(ID, { createIfEmpty: true });
  const query = api.tabGroups.query;
  let slow = true;
  api.tabGroups.query = async (props) => {
    if (slow) {
      slow = false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return query(props);
  };
  const reloaded = createSessions(api);
  const call = reloaded.context(ID);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reloaded.close(ID);
  await call;
  assert.equal(values.size, 0);
  assert.equal(await reloaded.sessionOfTab({ windowId: ctx.windowId }), null);
});

test("close removes the label from the window and its group and reports the session's tabs", async () => {
  const { api, windows, groups, addTab, addWindow } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const popupWindow = addWindow({ type: "popup" });
  const popup = addTab({ windowId: popupWindow, url: "https://login.test/", openerTabId: 1 });
  await sessions.adoptOpened(popup);
  await sessions.setStatus(ID, "busy");
  const left = await sessions.close(ID);
  assert.equal(windows.get(ctx.windowId).titlePreface, "");
  assert.equal([...groups.values()][0].title, "");
  assert.deepEqual(left.map((t) => t.id).sort(), [1, popup.id]);
});

test("close cleans up a session this background never loaded", async () => {
  const { api, values, windows } = fakeApi();
  const ctx = await createSessions(api).context(ID, { createIfEmpty: true });
  const loaded = [];
  const reloaded = createSessions(api, { onLoaded: (id) => loaded.push(id) });
  assert.deepEqual((await reloaded.close(ID)).map((t) => t.id), [1]);
  assert.equal(values.size, 0);
  assert.equal(windows.get(ctx.windowId).titlePreface, "");
  assert.deepEqual(loaded, []);
});

test("closing the main window reports the popup tabs that left the session", async () => {
  const { api, addTab, addWindow, closeWindow } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context(ID, { createIfEmpty: true });
  const popupWindow = addWindow({ type: "popup" });
  const popup = addTab({ windowId: popupWindow, url: "https://login.test/", openerTabId: 1 });
  await sessions.adoptOpened(popup);
  const other = addWindow();
  closeWindow(other);
  assert.deepEqual(await sessions.windowRemoved(other), []);
  closeWindow(ctx.windowId);
  const left = await sessions.windowRemoved(ctx.windowId);
  assert.deepEqual(left.map((t) => t.id), [popup.id]);
  assert.equal(await sessions.sessionOfTab(left[0]), null);
});

describe("grouped sessions", () => {
  const OTHER = "efgh5678-0000-4000-8000-000000000000";
  const setup = (options) => {
    const fake = fakeApi(options);
    const user = fake.addWindow({ focused: true });
    const mine = fake.addTab({ windowId: user, url: "https://mine.test/", active: true });
    return { ...fake, user, mine, sessions: createSessions(fake.api, { grouped: Promise.resolve(true) }) };
  };

  test("createIfEmpty adds one background tab in a group of the user's window and opens no window", async () => {
    const { sessions, windows, groups, tabs, values, user, mine } = setup();
    const ctx = await sessions.context(ID, { createIfEmpty: true });
    assert.equal(ctx.windowId, user);
    assert.equal(ctx.availableTabs.length, 1);
    const tab = tabs.get(ctx.availableTabs[0].tabId);
    assert.equal(tab.active, false);
    assert.equal(tabs.get(mine.id).active, true);
    assert.equal(tabs.get(mine.id).groupId, -1);
    assert.deepEqual([...groups.values()].map((g) => g.title), ["Claude · abcd"]);
    assert.equal(windows.size, 1);
    assert.equal(windows.get(user).titlePreface, "");
    assert.deepEqual(values.get(`${user}:claudeSession:${ID}`), { sessionId: ID, role: "main", stopped: false, groupId: 100 });
    assert.equal(values.has(`${user}:claudeSession`), false);
  });

  test("the user's tabs in the same window are refused, and tabs in the group are accepted", async () => {
    const { sessions, mine } = setup();
    const ctx = await sessions.context(ID, { createIfEmpty: true });
    const own = ctx.availableTabs[0].tabId;
    assert.equal((await sessions.ownedTab(ID, own)).id, own);
    await assert.rejects(sessions.ownedTab(ID, mine.id), { message: `Tab ${mine.id} is not in this session's tab group. Valid tab IDs: ${own}` });
    assert.equal(await sessions.sessionOfTab(mine), null);
  });

  test("two sessions in one window each own only their own group", async () => {
    const { sessions } = setup();
    const a = (await sessions.context(ID, { createIfEmpty: true })).availableTabs[0].tabId;
    const b = (await sessions.context(OTHER, { createIfEmpty: true })).availableTabs[0].tabId;
    await assert.rejects(sessions.ownedTab(ID, b), /not in this session's tab group/);
    await assert.rejects(sessions.ownedTab(OTHER, a), /not in this session's tab group/);
  });

  test("createTab adds a background tab to the group, and activate leaves the user's tab in front", async () => {
    const { sessions, tabs, mine } = setup();
    const ctx = await sessions.context(ID, { createIfEmpty: true });
    const tab = await sessions.createTab(ID);
    assert.equal(tabs.get(tab.id).active, false);
    assert.equal(tabs.get(tab.id).groupId, tabs.get(ctx.availableTabs[0].tabId).groupId);
    await sessions.activate(tabs.get(tab.id));
    assert.equal(tabs.get(tab.id).active, false);
    assert.equal(tabs.get(mine.id).active, true);
  });

  test("a new group replaces one whose tabs were all closed", async () => {
    const { sessions, tabs, groups } = setup();
    const ctx = await sessions.context(ID, { createIfEmpty: true });
    tabs.delete(ctx.availableTabs[0].tabId);
    groups.clear();
    const tab = await sessions.createTab(ID);
    assert.equal((await sessions.ownedTab(ID, tab.id)).id, tab.id);
    assert.deepEqual([...groups.values()].map((g) => g.title), ["Claude · abcd"]);
  });

  test("without tab groups no session starts and no tab is left behind", async () => {
    const { sessions, tabs, mine } = setup({ groups: false });
    await assert.rejects(sessions.context(ID, { createIfEmpty: true }), { message: NEEDS_GROUPS_MESSAGE });
    assert.deepEqual([...tabs.keys()], [mine.id]);
  });

  test("tabs opened from a session tab join the group, and tabs opened from the user's tabs do not", async () => {
    const { sessions, addTab, tabs, user, mine } = setup();
    const own = (await sessions.context(ID, { createIfEmpty: true })).availableTabs[0].tabId;
    const child = addTab({ windowId: user, url: "https://x.test/", openerTabId: own });
    await sessions.adoptOpened(child);
    assert.equal((await sessions.ownedTab(ID, child.id)).id, child.id);
    const users = addTab({ windowId: user, url: "https://y.test/", openerTabId: mine.id });
    await sessions.adoptOpened(users);
    assert.equal(tabs.get(users.id).groupId, -1);
  });

  test("a reloaded background recovers the group and its stop state", async () => {
    const { api, sessions, tabs, user, mine } = setup();
    const own = (await sessions.context(ID, { createIfEmpty: true })).availableTabs[0].tabId;
    await sessions.setStopped(ID, true);
    const reloaded = createSessions(api);
    const ctx = await reloaded.context(ID);
    assert.deepEqual([ctx.windowId, ctx.availableTabs.map((t) => t.tabId)], [user, [own]]);
    assert.equal(await reloaded.isStopped(ID), true);
    assert.equal(await reloaded.sessionOfTab(tabs.get(mine.id)), null);
  });

  test("a failed join keeps the existing group, so the session's other tabs stay its own", async () => {
    const { api, sessions, tabs } = setup();
    const own = (await sessions.context(ID, { createIfEmpty: true })).availableTabs[0].tabId;
    const group = api.tabs.group;
    api.tabs.group = async (props) => { if (props.groupId != null) throw new Error("cannot group this tab"); return group(props); };
    await assert.rejects(sessions.createTab(ID), /could not join this session's tab group/);
    assert.equal((await sessions.ownedTab(ID, own)).id, own);
    assert.equal(tabs.size, 2);
  });

  test("a reloaded background finds its group by the saved ID even when another session's group has the same name", async () => {
    const { api, sessions, groups, user } = setup();
    const own = (await sessions.context(ID, { createIfEmpty: true })).availableTabs[0].tabId;
    const twin = "abcd9999-0000-4000-8000-000000000000";
    await sessions.context(twin, { createIfEmpty: true });
    const [first, second] = [...groups.keys()];
    // The twin's group comes first in the window, under the same short name.
    groups.set(first, { ...groups.get(first), title: "Claude · abcd" });
    groups.set(second, { ...groups.get(second), title: "Claude · abcd" });
    const reordered = new Map([[second, groups.get(second)], [first, groups.get(first)]]);
    groups.clear();
    for (const [id, g] of reordered) groups.set(id, g);
    const ctx = await createSessions(api).context(ID);
    assert.deepEqual([ctx.windowId, ctx.availableTabs.map((t) => t.tabId)], [user, [own]]);
  });

  test("a new session never starts inside another session's popup window", async () => {
    const { api, sessions, addTab, addWindow, windows, user } = setup();
    const own = (await sessions.context(ID, { createIfEmpty: true })).availableTabs[0].tabId;
    const popupWindow = addWindow();
    await sessions.adoptOpened(addTab({ windowId: popupWindow, url: "https://login.test/", openerTabId: own }));
    for (const w of windows.values()) w.focused = w.id === popupWindow;
    const ctx = await sessions.context(OTHER, { createIfEmpty: true });
    assert.equal(ctx.windowId, user);
  });

  test("sharesUserWindow is true only for a grouped session's tabs in the user's window", async () => {
    const { sessions, tabs, addTab, addWindow, mine } = setup();
    const own = (await sessions.context(ID, { createIfEmpty: true })).availableTabs[0].tabId;
    const popupWindow = addWindow({ type: "popup" });
    const popup = addTab({ windowId: popupWindow, url: "https://login.test/", openerTabId: own });
    await sessions.adoptOpened(popup);
    assert.equal(await sessions.sharesUserWindow(tabs.get(own)), true);
    assert.equal(await sessions.sharesUserWindow(popup), false);
    assert.equal(await sessions.sharesUserWindow(mine), false);
  });

  test("close ungroups the session's tabs, keeps them open and clears its value", async () => {
    const { sessions, tabs, values, windows, user } = setup();
    const own = (await sessions.context(ID, { createIfEmpty: true })).availableTabs[0].tabId;
    const left = await sessions.close(ID);
    assert.deepEqual(left.map((t) => t.id), [own]);
    assert.equal(tabs.get(own).groupId, -1);
    assert.equal(values.size, 0);
    assert.equal(windows.get(user).titlePreface, "");
    assert.equal(await sessions.context(ID), null);
  });
});
