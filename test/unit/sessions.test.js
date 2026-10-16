import test from "node:test";
import assert from "node:assert/strict";
import { NO_GROUP_MESSAGE, createSessions } from "../../extension/background/sessions.js";

function fakeApi() {
  let nextTab = 1;
  let nextGroup = 100;
  const tabs = new Map();
  const groups = new Map();
  const copy = (t) => ({ ...t });
  const api = {
    windows: {
      getLastFocused: async () => ({ id: 1 }),
      create: async ({ url }) => { const t = { id: nextTab++, windowId: 2, url, title: "", groupId: -1 }; tabs.set(t.id, t); return { id: 2, tabs: [copy(t)] }; },
    },
    tabs: {
      create: async ({ windowId = 1, url, openerTabId }) => { const t = { id: nextTab++, windowId, url, title: "", groupId: -1, openerTabId }; tabs.set(t.id, t); return copy(t); },
      get: async (id) => { if (!tabs.has(id)) throw new Error(`Invalid tab ID: ${id}`); return copy(tabs.get(id)); },
      query: async ({ groupId }) => [...tabs.values()].filter((t) => t.groupId === groupId).map(copy),
      group: async ({ tabIds, groupId }) => {
        if (groupId != null && !groups.has(groupId)) throw new Error(`No group with id: ${groupId}`);
        const id = groupId ?? nextGroup++;
        if (!groups.has(id)) groups.set(id, { title: "", color: "" });
        for (const tabId of [].concat(tabIds)) tabs.get(tabId).groupId = id;
        return id;
      },
      remove: async (id) => {
        const { groupId } = tabs.get(id);
        tabs.delete(id);
        if (![...tabs.values()].some((t) => t.groupId === groupId)) groups.delete(groupId);
      },
    },
    tabGroups: {
      get: async (id) => { if (!groups.has(id)) throw new Error(`No group with id: ${id}`); return { id, ...groups.get(id) }; },
      update: async (id, props) => { Object.assign(groups.get(id), props); },
    },
  };
  return { api, tabs, groups };
}

test("context is null until the group is created on request", async () => {
  const sessions = createSessions(fakeApi().api);
  assert.equal(await sessions.context("abcd-1"), null);
});

test("createIfEmpty creates one blank background tab in a titled, colored group, once", async () => {
  const { api, groups } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context("abcd-1234", { createIfEmpty: true });
  assert.deepEqual(ctx.availableTabs, [{ tabId: 1, title: "", url: "about:blank" }]);
  assert.deepEqual(groups.get(ctx.tabGroupId), { title: "Claude · abcd", color: "orange" });
  assert.equal((await sessions.context("abcd-1234", { createIfEmpty: true })).availableTabs.length, 1);
});

test("each session gets its own group and color", async () => {
  const { api, groups } = fakeApi();
  const sessions = createSessions(api);
  const a = await sessions.context("aaaa", { createIfEmpty: true });
  const b = await sessions.context("bbbb", { createIfEmpty: true });
  assert.notEqual(a.tabGroupId, b.tabGroupId);
  assert.notEqual(groups.get(a.tabGroupId).color, groups.get(b.tabGroupId).color);
});

test("ownedTab accepts members and rejects other tabs with the valid IDs", async () => {
  const { api } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context("s", { createIfEmpty: true });
  const stranger = await api.tabs.create({ url: "https://other.test/" });
  assert.equal((await sessions.ownedTab("s", ctx.availableTabs[0].tabId)).id, ctx.availableTabs[0].tabId);
  await assert.rejects(sessions.ownedTab("s", stranger.id), new RegExp(`Tab ${stranger.id} is not in this session's tab group. Valid tab IDs: 1`));
  await assert.rejects(sessions.ownedTab("s", 999), /Tab 999 is not in this session's tab group/);
});

test("calls before a group exists explain how to create one", async () => {
  const sessions = createSessions(fakeApi().api);
  await assert.rejects(sessions.ownedTab("s", 1), { message: NO_GROUP_MESSAGE });
  await assert.rejects(sessions.createTab("s"), { message: NO_GROUP_MESSAGE });
});

test("createTab adds a blank background tab to the session's group", async () => {
  const { api } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context("s", { createIfEmpty: true });
  const tab = await sessions.createTab("s");
  assert.equal((await api.tabs.get(tab.id)).groupId, ctx.tabGroupId);
  assert.equal((await sessions.context("s")).availableTabs.length, 2);
});

test("a group the user removed is forgotten", async () => {
  const { api } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context("s", { createIfEmpty: true });
  await api.tabs.remove(ctx.availableTabs[0].tabId);
  assert.equal(await sessions.context("s"), null);
  await assert.rejects(sessions.ownedTab("s", ctx.availableTabs[0].tabId), { message: NO_GROUP_MESSAGE });
});

test("tabs opened from a session tab join its group and other tabs are left alone", async () => {
  const { api } = fakeApi();
  const sessions = createSessions(api);
  const ctx = await sessions.context("s", { createIfEmpty: true });
  const child = await api.tabs.create({ url: "https://x.test/", openerTabId: ctx.availableTabs[0].tabId });
  await sessions.adoptOpened(child);
  assert.equal((await api.tabs.get(child.id)).groupId, ctx.tabGroupId);
  const outsider = await api.tabs.create({ url: "https://y.test/" });
  const grandchild = await api.tabs.create({ url: "https://z.test/", openerTabId: outsider.id });
  await sessions.adoptOpened(grandchild);
  assert.equal((await api.tabs.get(grandchild.id)).groupId, -1);
});

test("close forgets the session", async () => {
  const { api } = fakeApi();
  const sessions = createSessions(api);
  await sessions.context("s", { createIfEmpty: true });
  sessions.close("s");
  assert.equal(await sessions.context("s"), null);
});
