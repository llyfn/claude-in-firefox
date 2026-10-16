import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { imagesOf, startHarness, textOf } from "./harness.js";

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

describe("forms and page text", () => {
  const refFor = (tree, role, name) => new RegExp(`${role} "${name}" \\[(ref_\\d+)\\]`).exec(tree)[1];
  let tabId;
  let tree;
  const log = async () => textOf(await h.call("get_page_text", { tabId }));

  before(async () => {
    tabId = await openTab("/forms.html");
    tree = textOf(await h.call("read_page", { tabId }));
  });

  test("form_input updates a React-style controlled input", async () => {
    assert.equal(textOf(await h.call("form_input", { tabId, ref: refFor(tree, "textbox", "Name"), value: "Ada" })), 'Set text value to "Ada" (previous: "old")');
    assert.match(await log(), /name changed to Ada/);
  });

  test("form_input handles select, checkbox, radio, number, date, textarea and contenteditable", async () => {
    const set = (role, name, value) => h.call("form_input", { tabId, ref: refFor(tree, role, name), value });
    await set("combobox", "Country", "Korea");
    await set("checkbox", "I agree", true);
    await set("radio", "Large", true);
    await set("spinbutton", "Quantity", 4);
    await set("textbox", "Date", "2026-10-17");
    await set("textbox", "Bio", "Hello");
    await set("generic", "Notes", "Final notes");
    const text = await log();
    for (const line of ["country change kr", "agree change true", "size l", "qty change 4", "when change 2026-10-17", "bio change Hello", "notes input"]) assert.match(text, new RegExp(line));
  });

  test("form_input never echoes password values", async () => {
    assert.equal(textOf(await h.call("form_input", { tabId, ref: refFor(tree, "textbox", "Secret"), value: "s3cret" })), "Set password value to [redacted] (previous: [redacted])");
  });

  test("get_page_text prefers the article element", async () => {
    const articleTab = await openTab("/article.html");
    const text = textOf(await h.call("get_page_text", { tabId: articleTab }));
    assert.match(text, /^Title: Article page\nURL: http:\/\/127\.0\.0\.1:\d+\/article\.html\nSource element: <article>\n---\nHeadline/);
    assert.doesNotMatch(text, /Site navigation|Copyright footer/);
  });
});

describe("javascript_tool", () => {
  const js = (tabId, text) => h.call("javascript_tool", { tabId, action: "javascript_exec", text });

  test("returns values, awaits promises and describes DOM nodes", async () => {
    const tabId = await openTab("/basic.html");
    assert.equal(textOf(await js(tabId, "document.title")), "Basic page");
    assert.equal(textOf(await js(tabId, "Promise.resolve(6 * 7)")), "42");
    assert.equal(textOf(await js(tabId, "document.querySelector('h1')")), "<h1>");
  });

  test("reports page errors as tool errors", async () => {
    const tabId = await openTab("/basic.html");
    const result = await js(tabId, "nope.value");
    assert.equal(result.isError, true);
    assert.match(textOf(result), /ReferenceError/);
  });

  test("code with top-level await or return is wrapped", async () => {
    const tabId = await openTab("/basic.html");
    const text = textOf(await js(tabId, "const n = await Promise.resolve(5); return n * 2"));
    assert.match(text, /wrapped in an async function/);
    assert.match(text, /10$/);
  });

  test("strict-CSP pages fall back to the extension sandbox", async () => {
    const tabId = await openTab("/csp-page.html");
    const text = textOf(await js(tabId, "window.wrappedJSObject.pageVar"));
    assert.match(text, /^\[ran in extension sandbox/);
    assert.match(text, /42$/);
  });
});

describe("computer", () => {
  let tabId;
  let toShot;
  const computer = (args) => h.call("computer", { tabId, ...args });
  const log = async () => textOf(await h.call("get_page_text", { tabId }));
  const js = async (id, text) => textOf(await h.call("javascript_tool", { tabId: id, action: "javascript_exec", text }));
  async function frameMapper(id) {
    const [, w, hgt] = /Screenshot (\d+)x(\d+)/.exec(textOf(await h.call("computer", { tabId: id, action: "screenshot" }))).map(Number);
    const [, vw, vh] = /Viewport: (\d+)x(\d+)$/.exec(textOf(await h.call("read_page", { tabId: id, filter: "interactive" }))).map(Number);
    return (x, y) => [Math.round((x * w) / vw), Math.round((y * hgt) / vh)];
  }

  before(async () => {
    tabId = await openTab("/input.html");
    toShot = await frameMapper(tabId);
  });

  test("screenshot returns a JPEG image block", async () => {
    const result = await computer({ action: "screenshot" });
    assert.match(textOf(result), /^Screenshot \d+x\d+ \(jpeg\)$/);
    assert.equal(imagesOf(result)[0].mimeType, "image/jpeg");
    assert.ok(imagesOf(result)[0].data.length > 1000);
  });

  test("coordinate clicks, double clicks and right clicks reach the element", async () => {
    await computer({ action: "left_click", coordinate: toShot(140, 70) });
    await computer({ action: "double_click", coordinate: toShot(140, 70) });
    await computer({ action: "right_click", coordinate: toShot(140, 70) });
    const text = await log();
    assert.match(text, /clicked big/);
    assert.match(text, /dblclicked big/);
    assert.match(text, /context big/);
  });

  test("hover dispatches mouseover", async () => {
    await computer({ action: "hover", coordinate: toShot(320, 55) });
    assert.match(await log(), /hovered/);
  });

  test("click by ref, typing Unicode and Enter submit the form", async () => {
    const query = /textbox "Query" \[(ref_\d+)\]/.exec(textOf(await h.call("read_page", { tabId })))[1];
    assert.equal(textOf(await computer({ action: "left_click", ref: query })), `Clicked ${query}`);
    await computer({ action: "type", text: "héllo 👋" });
    await computer({ action: "key", text: "Enter" });
    assert.match(await log(), /submitted héllo 👋/);
  });

  test("cmd+a then Backspace clears the field and Tab moves focus on", async () => {
    await computer({ action: "key", text: "cmd+a BackSpace" });
    assert.doesNotMatch(textOf(await h.call("read_page", { tabId })), /textbox "Query" \[ref_\d+\] value=/);
    await computer({ action: "key", text: "Tab" });
    assert.equal(await js(tabId, "document.activeElement.textContent"), "Go");
  });

  test("scroll scrolls the element under the pointer and returns a screenshot", async () => {
    const result = await computer({ action: "scroll", coordinate: toShot(140, 180), scroll_direction: "down", scroll_amount: 2 });
    assert.equal(imagesOf(result).length, 1);
    assert.equal(await js(tabId, "document.getElementById('scroller').scrollTop"), "200");
  });

  test("left_click_drag performs HTML5 drag and drop", async () => {
    await computer({ action: "left_click_drag", start_coordinate: toShot(450, 60), coordinate: toShot(500, 160) });
    assert.match(await log(), /dropped payload/);
  });

  test("target=_blank links open in a new tab inside the session's group", async () => {
    const link = /link "Open basic in new tab" \[(ref_\d+)\]/.exec(textOf(await h.call("read_page", { tabId })))[1];
    const opened = Number(/link opened in new tab (\d+)/.exec(textOf(await computer({ action: "left_click", ref: link })))[1]);
    const ctx = JSON.parse(textOf(await h.call("tabs_context")));
    assert.ok(ctx.availableTabs.some((t) => t.tabId === opened));
  });

  test("zoom returns a PNG and wait pauses", async () => {
    const zoomed = await computer({ action: "zoom", region: [...toShot(40, 40), ...toShot(240, 100)] });
    assert.equal(imagesOf(zoomed)[0].mimeType, "image/png");
    assert.match(textOf(await computer({ action: "wait", duration: 0.5 })), /^Waited 0\.5 second/);
  });

  test("clicks reach cross-origin iframes by ref and by coordinate", async () => {
    const frames = `/frames.html?b=${encodeURIComponent(h.fixtures.b)}`;
    const byRef = await openTab(frames);
    const ref = /button "Frame button" \[(f\d+_ref_\d+)\]/.exec(textOf(await h.call("read_page", { tabId: byRef })))[1];
    await h.call("computer", { tabId: byRef, action: "left_click", ref });
    assert.match(textOf(await h.call("read_page", { tabId: byRef })), /frame clicked/);

    const byPoint = await openTab(frames);
    const map = await frameMapper(byPoint);
    await h.call("computer", { tabId: byPoint, action: "left_click", coordinate: map(105, 230) });
    assert.match(textOf(await h.call("read_page", { tabId: byPoint })), /frame clicked/);
  });
});

describe("console and network", () => {
  async function eventually(check, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        return await check();
      } catch (err) {
        if (Date.now() > end) throw err;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  test("console output from page load is captured and filterable", async () => {
    const tabId = await openTab("/console.html");
    await eventually(async () => {
      const all = textOf(await h.call("read_console_messages", { tabId }));
      assert.match(all, /\[LOG\] \(http:[^)]+\) page loaded 42/);
      assert.match(all, /\[LOG\] .*complex/);
      assert.match(all, /\[ERROR\] .*Error: boom on load/);
      assert.match(all, /\[EXCEPTION\] .*async explosion/);
    });
    assert.doesNotMatch(textOf(await h.call("read_console_messages", { tabId, onlyErrors: true })), /page loaded/);
    const filtered = textOf(await h.call("read_console_messages", { tabId, pattern: "boom" }));
    assert.match(filtered, /boom on load/);
    assert.doesNotMatch(filtered, /page loaded/);
  });

  test("network requests and later console calls are captured with details", async () => {
    const tabId = await openTab("/console.html");
    const button = /button "Log and fetch" \[(ref_\d+)\]/.exec(textOf(await h.call("read_page", { tabId })))[1];
    await h.call("computer", { tabId, action: "left_click", ref: button });
    await eventually(async () => assert.match(textOf(await h.call("read_network_requests", { tabId, urlPattern: "/api/" })), /url: http:\/\/127\.0\.0\.1:\d+\/api\/ping\n   method: GET\n   statusCode: 200/));
    await eventually(async () => assert.match(textOf(await h.call("read_console_messages", { tabId, pattern: "button warn" })), /\[WARN\] .*button warn \{"n":1\}/));
  });

  test("clear empties the console buffer", async () => {
    const tabId = await openTab("/console.html");
    await eventually(async () => assert.match(textOf(await h.call("read_console_messages", { tabId, clear: true })), /page loaded/));
    assert.match(textOf(await h.call("read_console_messages", { tabId, pattern: "page loaded" })), /No console messages found/);
  });
});

describe("file_upload and browser_batch", () => {
  test("file_upload puts local files into a file input", async () => {
    const tabId = await openTab("/upload.html");
    const ref = /button "Attachment" \[(ref_\d+)\]/.exec(textOf(await h.call("read_page", { tabId })))[1];
    const sample = fileURLToPath(new URL("./pages/upload-sample.txt", import.meta.url));
    assert.match(textOf(await h.call("file_upload", { tabId, ref, paths: [sample] })), /^Uploaded 1 file\(s\) to ref_\d+: upload-sample\.txt$/);
    assert.match(textOf(await h.call("get_page_text", { tabId })), /upload-sample\.txt 13 text\/plain/);
  });

  test("browser_batch runs steps in order and stops at the first error", async () => {
    const tabId = await openTab("/input.html");
    const result = await h.call("browser_batch", {
      actions: [
        { name: "computer", input: { tabId, action: "screenshot", scale: 0.5 } },
        { name: "navigate", input: { tabId, url: `${h.fixtures.a}/basic.html` } },
        { name: "computer", input: { tabId, action: "left_click", ref: "ref_999999" } },
        { name: "get_page_text", input: { tabId } },
      ],
    });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /\[0:computer\] Screenshot \d+x\d+ \(jpeg\), scaled/);
    assert.match(text, /\[1:navigate\] Navigated to/);
    assert.match(text, /\[2:computer\] Element ref_999999 not found/);
    assert.doesNotMatch(text, /\[3:/);
    assert.equal(imagesOf(result).length, 1);
  });
});
