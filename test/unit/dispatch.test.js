import test from "node:test";
import assert from "node:assert/strict";
import { createDispatcher } from "../../extension/background/dispatch.js";

function setup(tools, ownedTab = async (_sessionId, tabId) => ({ id: tabId, url: "https://example.test/", active: true }), { changes = "" } = {}) {
  const sent = [];
  const closed = [];
  const events = [];
  const activated = [];
  const activity = { start: (id) => events.push(["start", id]), end: (id) => events.push(["end", id]) };
  const sessions = { ownedTab, activate: async (tab) => activated.push(tab.id), tabChanges: async () => changes, close: async (id) => closed.push(id) };
  return { dispatch: createDispatcher({ tools, sessions, activity, send: (m) => sent.push(m) }), sent, closed, events, activated };
}
const call = (tool, args = {}, id = "1:1") => ({ type: "call", id, sessionId: "s", tool, args });

test("string results become text content carrying the call id", async () => {
  const { dispatch, sent } = setup({ hello: { tabScoped: false, run: async () => "hi" } });
  await dispatch(call("hello", {}, "2:7"));
  assert.deepEqual(sent, [{ type: "result", id: "2:7", content: [{ type: "text", text: "hi" }], isError: false }]);
});

test("content arrays pass through unchanged", async () => {
  const blocks = [{ type: "text", text: "a" }, { type: "image", data: "AA", mimeType: "image/png" }];
  const { dispatch, sent } = setup({ shot: { tabScoped: false, run: async () => blocks } });
  await dispatch(call("shot"));
  assert.deepEqual(sent[0].content, blocks);
});

test("thrown errors and unknown tools become isError results", async () => {
  const { dispatch, sent } = setup({ boom: { tabScoped: false, run: async () => { throw new Error("kaput"); } } });
  await dispatch(call("boom"));
  await dispatch(call("nope"));
  assert.deepEqual(sent.map((m) => [m.isError, m.content[0].text]), [[true, "kaput"], [true, "Unknown tool: nope"]]);
});

test("tab-scoped tools receive the owned tab and drive the indicator", async () => {
  let seen;
  const { dispatch, events } = setup({ look: { tabScoped: true, run: async (ctx) => { seen = ctx; return "ok"; } } });
  await dispatch(call("look", { tabId: 5 }));
  assert.equal(seen.tab.id, 5);
  assert.equal(seen.sessionId, "s");
  assert.deepEqual(events, [["start", 5], ["end", 5]]);
});

test("ownership failures are errors and never start the indicator", async () => {
  const { dispatch, sent, events } = setup({ look: { tabScoped: true, run: async () => "ok" } }, async () => { throw new Error("Tab 9 is not in this session's window. Valid tab IDs: 5"); });
  await dispatch(call("look", { tabId: 9 }));
  assert.equal(sent[0].isError, true);
  assert.match(sent[0].content[0].text, /Valid tab IDs: 5/);
  assert.deepEqual(events, []);
});

test("numeric-string tab IDs are accepted and missing ones rejected", async () => {
  let seenArgs;
  const { dispatch, sent } = setup({ look: { tabScoped: true, run: async ({ args }) => { seenArgs = args; return "ok"; } } });
  await dispatch(call("look", { tabId: "12" }));
  assert.equal(seenArgs.tabId, 12);
  await dispatch(call("look", {}));
  assert.match(sent[1].content[0].text, /tabId must be an integer/);
});

test("calls on one tab run one at a time while other tabs proceed", async () => {
  const log = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tools = { slow: { tabScoped: true, async run({ args }) { log.push(`start ${args.n}`); if (args.n === 1) await gate; log.push(`end ${args.n}`); return "ok"; } } };
  const { dispatch } = setup(tools);
  const first = dispatch(call("slow", { tabId: 1, n: 1 }, "1:1"));
  const second = dispatch(call("slow", { tabId: 1, n: 2 }, "1:2"));
  await dispatch(call("slow", { tabId: 2, n: 3 }, "1:3"));
  assert.ok(log.includes("start 1") && log.includes("end 3"));
  assert.ok(!log.includes("start 2"));
  release();
  await Promise.all([first, second]);
  assert.ok(log.indexOf("end 1") < log.indexOf("start 2"));
});

test("session_closed forgets the session and sends nothing", async () => {
  const { dispatch, sent, closed } = setup({});
  await dispatch({ type: "session_closed", sessionId: "gone" });
  assert.deepEqual(closed, ["gone"]);
  assert.deepEqual(sent, []);
});

test("the owned tab is made active before the tool runs", async () => {
  let activatedWhenRun;
  const tools = { look: { tabScoped: true, run: async () => { activatedWhenRun = [...activated]; return "ok"; } } };
  const { dispatch, activated } = setup(tools);
  await dispatch(call("look", { tabId: 5 }));
  assert.deepEqual(activatedWhenRun, [5]);
});

test("tab changes are appended to results except tabs_context, which lists every tab", async () => {
  const tools = { look: { tabScoped: false, run: async () => "ok" }, tabs_context: { tabScoped: false, run: async () => "{}" } };
  const { dispatch, sent } = setup(tools, undefined, { changes: "Tabs changed: closed 3" });
  await dispatch(call("look"));
  await dispatch(call("tabs_context"));
  assert.deepEqual(sent[0].content, [{ type: "text", text: "ok" }, { type: "text", text: "Tabs changed: closed 3" }]);
  assert.deepEqual(sent[1].content, [{ type: "text", text: "{}" }]);
});
