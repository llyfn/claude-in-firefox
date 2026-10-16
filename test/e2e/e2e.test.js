import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./harness.js";

let h;
before(async () => { h = await startHarness(); }, { timeout: 180_000 });
after(async () => { await h?.close(); }, { timeout: 60_000 });

async function openTab(path, origin = h.fixtures.a) {
  const created = textOf(await h.call("tabs_create"));
  const tabId = Number(/Created tab (\d+)/.exec(created)[1]);
  const nav = await h.call("navigate", { tabId, url: `${origin}${path}` });
  assert.equal(nav.isError, false, textOf(nav));
  return tabId;
}

describe("tabs and navigation", () => {
  test("tabs_context asks for createIfEmpty before a group exists", async () => {
    assert.match(textOf(await h.call("tabs_context")), /createIfEmpty: true/);
  });

  test("tabs_context with createIfEmpty creates a group holding one tab", async () => {
    const ctx = JSON.parse(textOf(await h.call("tabs_context", { createIfEmpty: true })));
    assert.equal(ctx.availableTabs.length, 1);
    assert.ok(Number.isInteger(ctx.tabGroupId));
  });

  test("navigate waits for the load and reports URL and title", async () => {
    const tabId = await openTab("/basic.html");
    const r = await h.call("navigate", { tabId, url: `${h.fixtures.a}/basic.html?again` });
    assert.match(textOf(r), /^Navigated to http:\/\/127\.0\.0\.1:\d+\/basic\.html\?again — "Basic page"$/);
  });

  test("navigate back returns to the previous page", async () => {
    const tabId = await openTab("/basic.html?first");
    await h.call("navigate", { tabId, url: `${h.fixtures.a}/basic.html?second` });
    assert.match(textOf(await h.call("navigate", { tabId, url: "back" })), /basic\.html\?first/);
  });

  test("another session cannot touch this session's tabs", async () => {
    const tabId = await openTab("/basic.html");
    const other = await h.connect();
    const noGroup = await other.call("navigate", { tabId, url: "about:blank" });
    assert.equal(noGroup.isError, true);
    assert.match(textOf(noGroup), /no tab group yet/);
    await other.call("tabs_context", { createIfEmpty: true });
    const denied = await other.call("navigate", { tabId, url: "about:blank" });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), new RegExp(`Tab ${tabId} is not in this session's tab group`));
    await other.close();
  });

  test("closed tabs leave the group and can no longer be used", async () => {
    const tabId = await openTab("/basic.html");
    await h.call("tabs_close", { tabId });
    const ctx = JSON.parse(textOf(await h.call("tabs_context")));
    assert.ok(!ctx.availableTabs.some((t) => t.tabId === tabId));
    const r = await h.call("navigate", { tabId, url: "about:blank" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Valid tab IDs: \d+/);
  });

  test("resize_window resizes the tab's window", async () => {
    const tabId = await openTab("/basic.html");
    assert.equal(textOf(await h.call("resize_window", { tabId, width: 1280, height: 900 })), "Resized window to 1280x900");
  });
});

describe("reading pages", () => {
  test("read_page shows landmarks, refs, options, shadow DOM and redacted secrets", async () => {
    const tabId = await openTab("/tree.html");
    const text = textOf(await h.call("read_page", { tabId }));
    assert.match(text, /link "Home" \[ref_\d+\] href="\/basic.html"/);
    assert.match(text, /textbox "Email" \[ref_\d+\] type="email" placeholder="you@example.com"/);
    assert.match(text, /option "United States" \(selected\) value="us"/);
    assert.match(text, /textbox "Password" \[ref_\d+\] type="password" value="\[value redacted\]"/);
    assert.doesNotMatch(text, /hunter2/);
    assert.match(text, /button "Shadow action" \[ref_\d+\]/);
    assert.match(text, /\n\nViewport: \d+x\d+$/);
  });

  test("refs are stable between calls", async () => {
    const tabId = await openTab("/tree.html");
    const ref = (text) => /button "Subscribe" \[(ref_\d+)\]/.exec(text)[1];
    const first = ref(textOf(await h.call("read_page", { tabId })));
    const second = ref(textOf(await h.call("read_page", { tabId, filter: "interactive" })));
    assert.equal(first, second);
  });

  test("the interactive filter drops off-screen and non-interactive elements", async () => {
    const tabId = await openTab("/tree.html");
    const text = textOf(await h.call("read_page", { tabId, filter: "interactive" }));
    assert.match(text, /Subscribe/);
    assert.doesNotMatch(text, /Far below|Welcome/);
  });

  test("ref_id focuses on one subtree and max_chars truncates", async () => {
    const tabId = await openTab("/tree.html");
    const full = textOf(await h.call("read_page", { tabId }));
    const navRef = /navigation \[(ref_\d+)\]/.exec(full)[1];
    const nav = textOf(await h.call("read_page", { tabId, ref_id: navRef }));
    assert.match(nav, /About us/);
    assert.doesNotMatch(nav, /Subscribe/);
    assert.match(textOf(await h.call("read_page", { tabId, max_chars: 200 })), /\[output truncated at \d+ of \d+ characters/);
  });

  test("same-origin and cross-origin iframe contents are included", async () => {
    const tabId = await openTab(`/frames.html?b=${encodeURIComponent(h.fixtures.b)}`);
    const text = textOf(await h.call("read_page", { tabId }));
    assert.match(text, /button "Same-origin button" \[ref_\d+\]/);
    assert.match(text, /iframe "Cross-origin frame" \[ref_\d+\] \[frame \d+\]/);
    assert.match(text, /button "Frame button" \[f\d+_ref_\d+\]/);
  });

  test("find ranks the best keyword match first", async () => {
    const tabId = await openTab("/tree.html");
    const text = textOf(await h.call("find", { tabId, query: "subscribe button" }));
    assert.match(text, /^Found \d+ element\(s\) matching "subscribe button", best first:\n\n- ref_\d+: button "Subscribe"/);
  });
});
