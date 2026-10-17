import test from "node:test";
import assert from "node:assert/strict";
import { createPresence } from "../../extension/background/presence.js";

function setup() {
  const calls = [];
  const membership = new Map([[1, "s"], [2, "s"]]);
  const stopped = new Set();
  const sessions = {
    sessionOfTab: async (tab) => membership.get(tab.id) ?? null,
    isStopped: async (id) => stopped.has(id),
    sessionTabs: async (id) => [...membership].filter(([, s]) => s === id).map(([tabId]) => ({ id: tabId })),
  };
  const content = { call: async (tabId, frameId, op, args) => { calls.push([tabId, op, args.state]); } };
  const presence = createPresence({ api: { tabs: { sendMessage: async (tabId, message) => { calls.push([tabId, "dialogs.enable", message.args.on]); } } }, content, sessions });
  return { presence, calls, membership, stopped };
}

test("session tabs are told their state and other tabs are left alone", async () => {
  const { presence, calls } = setup();
  await presence.refreshTab({ id: 1 });
  await presence.refreshTab({ id: 9 });
  assert.deepEqual(calls, [[1, "indicator.session", "active"], [1, "dialogs.enable", true]]);
});

test("a stopped session shows Resume in every tab, and a tab that left the session is cleared once", async () => {
  const { presence, calls, membership, stopped } = setup();
  stopped.add("s");
  await presence.refreshSession("s");
  assert.deepEqual(calls, [[1, "indicator.session", "stopped"], [2, "indicator.session", "stopped"], [1, "dialogs.enable", false], [2, "dialogs.enable", false]]);
  membership.delete(2);
  await presence.refreshTab({ id: 2 });
  await presence.refreshTab({ id: 2 });
  assert.deepEqual(calls.slice(4), [[2, "indicator.session", null], [2, "dialogs.enable", false]]);
});

test("stateFor reports the state and marks the tab so a later departure clears it", async () => {
  const { presence, calls, membership } = setup();
  assert.equal(await presence.stateFor({ id: 1 }), "active");
  assert.equal(await presence.stateFor({ id: 9 }), null);
  membership.delete(1);
  await presence.refreshTab({ id: 1 });
  await presence.refreshTab({ id: 9 });
  assert.deepEqual(calls, [[1, "indicator.session", null], [1, "dialogs.enable", false]]);
});

test("refreshTabs continues past a tab that fails", async () => {
  const { presence, calls, membership } = setup();
  membership.get = (id) => { if (id === 9) throw new Error("boom"); return Map.prototype.get.call(membership, id); };
  await presence.refreshTabs([{ id: 9 }, { id: 1 }, { id: 2 }]);
  assert.deepEqual(calls, [[1, "indicator.session", "active"], [2, "indicator.session", "active"], [1, "dialogs.enable", true], [2, "dialogs.enable", true]]);
});

test("dialog auto-answering is on only for tabs of a running session", async () => {
  const { presence, stopped } = setup();
  assert.equal(await presence.dialogsEnabled({ id: 1 }), true);
  assert.equal(await presence.dialogsEnabled({ id: 9 }), false);
  stopped.add("s");
  assert.equal(await presence.dialogsEnabled({ id: 1 }), false);
});
