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
  const presence = createPresence({ api: {}, content, sessions });
  return { presence, calls, membership, stopped };
}

test("session tabs are told their state and other tabs are left alone", async () => {
  const { presence, calls } = setup();
  await presence.refreshTab({ id: 1 });
  await presence.refreshTab({ id: 9 });
  assert.deepEqual(calls, [[1, "indicator.session", "active"]]);
});

test("a stopped session shows Resume in every tab, and a tab that left the session is cleared once", async () => {
  const { presence, calls, membership, stopped } = setup();
  stopped.add("s");
  await presence.refreshSession("s");
  assert.deepEqual(calls, [[1, "indicator.session", "stopped"], [2, "indicator.session", "stopped"]]);
  membership.delete(2);
  await presence.refreshTab({ id: 2 });
  await presence.refreshTab({ id: 2 });
  assert.deepEqual(calls.slice(2), [[2, "indicator.session", null]]);
});
