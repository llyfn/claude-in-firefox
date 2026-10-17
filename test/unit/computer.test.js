import test from "node:test";
import assert from "node:assert/strict";
import { computerTool } from "../../extension/background/tools/computer.js";

function setup(replies = {}, { suffix = "" } = {}) {
  const calls = [];
  const created = [];
  const grouped = [];
  const api = {
    tabs: {
      get: async () => ({ id: 1, url: "https://a.test/" }),
      create: async (props) => { created.push(props); return { id: 50 + created.length }; },
      group: async (props) => { grouped.push(props); },
      reload: async (id, props) => { calls.push(["reload", id, props]); },
    },
  };
  const content = {
    call: async (tabId, frameId, op, args) => {
      calls.push([frameId, op, args]);
      const reply = replies[`${frameId}:${op}`];
      return typeof reply === "function" ? reply(args) : reply ?? {};
    },
  };
  const capture = {
    toCss: (tabId, [x, y]) => ({ x: x * 2, y: y * 2 }),
    screenshot: async () => ({ base64: "AAAA", mimeType: "image/jpeg", width: 640, height: 400, frame: { width: 640, height: 400 } }),
    zoom: async () => ({ base64: "BBBB", mimeType: "image/png", width: 300, height: 200 }),
  };
  const watched = [];
  const watch = (_api, tabId) => {
    const watcher = { tabId, stopped: false, settle: async () => suffix, stop() { watcher.stopped = true; } };
    watched.push(watcher);
    return watcher;
  };
  const { computer } = computerTool({ api, content, capture, watch });
  const tab = { id: 1, url: "https://a.test/", windowId: 3, groupId: 9 };
  return { run: (args, signal) => computer.run({ tab, args, signal }), calls, created, grouped, watched };
}

test("coordinate clicks map to CSS pixels, accept numeric strings and carry the host guard", async () => {
  const { run, calls } = setup();
  assert.equal(await run({ action: "left_click", coordinate: ["10", "20"] }), "Clicked at (10, 20)");
  assert.deepEqual(calls[0], [0, "input.click", { x: 20, y: 40, button: "left", count: 1, modifiers: "", guard: { host: "a.test", action: "left_click" } }]);
});

test("ref and coordinate together are rejected and a missing target is explained", async () => {
  const { run } = setup();
  await assert.rejects(run({ action: "left_click", ref: "ref_1", coordinate: [1, 1] }), /either ref or coordinate, not both/);
  await assert.rejects(run({ action: "hover" }), /coordinate \[x, y\] or ref is required/);
});

test("frame-prefixed refs go straight to their frame with the host checked by the background", async () => {
  const { run, calls } = setup();
  assert.equal(await run({ action: "double_click", ref: "f7_ref_3" }), "Double-clicked f7_ref_3");
  assert.deepEqual(calls[0], [7, "input.click", { ref: "f7_ref_3", button: "left", count: 2, modifiers: "", guard: null }]);
});

test("cross-origin redirects are followed into the frame with local coordinates", async () => {
  const { run, calls } = setup({ "0:input.click": { redirect: { frameId: 7, x: 5, y: 6 } } });
  await run({ action: "left_click", coordinate: [10, 20] });
  assert.deepEqual(calls.slice(0, 2).map((c) => [c[0], c[1]]), [[0, "input.click"], [7, "input.click"]]);
  assert.deepEqual(calls[1][2], { x: 5, y: 6, button: "left", count: 1, modifiers: "", guard: null });
});

test("links that would open a new tab are opened inside the session's group", async () => {
  const { run, created, grouped } = setup({ "0:input.click": { opened: ["https://b.test/"], point: { x: 1, y: 2 } } });
  assert.equal(await run({ action: "left_click", ref: "ref_4" }), "Clicked ref_4 (link opened in new tab 51)");
  assert.deepEqual(created, [{ url: "https://b.test/", openerTabId: 1, windowId: 3, active: false }]);
  assert.deepEqual(grouped, [{ groupId: 9, tabIds: [51] }]);
});

test("reload chords reload the tab and other keys report what was pressed", async () => {
  const { run, calls } = setup({ "0:input.keys": (args) => (args.spec === "cmd+shift+r" ? { reload: { bypassCache: true } } : {}) });
  assert.equal(await run({ action: "key", text: "cmd+shift+r" }), "Reloaded the tab (bypassing the cache)");
  assert.deepEqual(calls.find((c) => c[0] === "reload"), ["reload", 1, { bypassCache: true }]);
  assert.equal(await run({ action: "key", text: "Tab", repeat: "3" }), "Pressed Tab ×3");
});

test("screenshot, scroll and zoom return image blocks and bad input is rejected", async () => {
  const { run } = setup();
  assert.deepEqual(await run({ action: "screenshot" }), [{ type: "text", text: "Screenshot 640x400 (jpeg)" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }]);
  const scrolled = await run({ action: "scroll", coordinate: [1, 1], scroll_direction: "down" });
  assert.equal(scrolled[0].text, "Scrolled down by 3 at (1, 1)");
  assert.equal(scrolled.at(-1).type, "image");
  assert.equal((await run({ action: "zoom", region: [0, 0, 10, 10] }))[1].mimeType, "image/png");
  await assert.rejects(run({ action: "scroll", coordinate: [1, 1], scroll_direction: "sideways" }), /scroll_direction must be/);
  await assert.rejects(run({ action: "wait", duration: 31 }), /between 0 and 30/);
  await assert.rejects(run({ action: "teleport" }), /unknown action "teleport"/);
});

test("clicks, typing and keys report the navigation they started", async () => {
  const { run, watched } = setup({}, { suffix: '→ Navigated to https://b.test/ — "B"' });
  assert.equal(await run({ action: "left_click", coordinate: [1, 1] }), 'Clicked at (1, 1) → Navigated to https://b.test/ — "B"');
  assert.equal(await run({ action: "type", text: "hi" }), 'Typed "hi" → Navigated to https://b.test/ — "B"');
  assert.equal(await run({ action: "key", text: "Enter" }), 'Pressed Enter → Navigated to https://b.test/ — "B"');
  assert.equal(watched.length, 3);
  await run({ action: "screenshot" });
  await run({ action: "hover", coordinate: [1, 1] });
  assert.equal(watched.length, 3);
});

test("a failed action stops watching for navigations", async () => {
  const { run, watched } = setup({ "0:input.click": () => { throw new Error("No element at (1, 1)."); } });
  await assert.rejects(run({ action: "left_click", coordinate: [1, 1] }), /No element/);
  assert.equal(watched[0].stopped, true);
});

test("an aborted wait returns early", async () => {
  const { run } = setup();
  const controller = new AbortController();
  const started = Date.now();
  const waiting = run({ action: "wait", duration: 30 }, controller.signal);
  controller.abort();
  await waiting;
  assert.ok(Date.now() - started < 1000);
});
