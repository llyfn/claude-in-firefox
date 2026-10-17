# Session Control and Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Claude session its own Firefox window with a user-only Stop/Resume control, auto-answered dialogs, navigation-aware actions, and a set of smaller tool improvements.

**Architecture:** The MV2 background page gains three modules (`control.js` for stop/resume and abort signals, `presence.js` for telling pages their session state, `dialogs.js` for collecting dialog reports) and one moved module (`navigation.js`). `sessions.js` is rewritten to own windows instead of tab groups and persists membership with `browser.sessions` window values. A new content script `dialogs.js` replaces page dialogs in session tabs. The MCP server coerces loosely typed arguments before forwarding.

**Tech Stack:** Firefox WebExtensions MV2 (Firefox ≥ 140), Node ≥ 22.22, `node:test` + jsdom for unit tests, the existing e2e harness driving Firefox Developer Edition through `web-ext run`.

**Spec:** `docs/superpowers/specs/2026-10-17-session-control-design.md`

## Global Constraints

- Background and host code are ES modules; content scripts are classic IIFEs that attach to `globalThis.__cf` and return early when their key already exists.
- No new dependencies. Use `npm test`, `npm run lint`, `npm run e2e`.
- Comments only for constraints the code cannot show; no comments about the change itself.
- Commit after each task with a plain message (no AI attribution, no session links, no co-author trailers).
- User-visible strings are exactly as written in this plan (they come from the spec).
- `STOPPED_MESSAGE` = `The user pressed Stop in Firefox. Stop using the browser and ask the user how to continue. Browser calls fail until they press Resume.`
- `NO_SESSION_MESSAGE` = `This session has no window yet. Call tabs_context with createIfEmpty: true first.`
- Window value key: `claudeSession`, value `{ sessionId, role: "main" | "popup", stopped }`.
- Labels: `<prefix>Claude · <first 8 chars of sessionId>` with prefixes `""` (new), `"⌛ "` (busy), `"✅ "` (idle), `"⏸ "` (stopped). Window title preface is the label plus `" — "`.
- E2E tests are updated and run only in Task 9 (they need a real Firefox); Tasks 1–8 run `npm test` and `npm run lint`.

## Review Focus

1. Stop pressed while a call is waiting (navigate, wait, settle) or queued behind another call → every one of those calls gets exactly one `STOPPED_MESSAGE` result, and the queued tool body never runs (Task 7 test "Stop rejects the running and queued calls of the session with one result each").
2. Lenient argument coercion must never change a valid string: `form_input` `value: "123"` and `computer` `text: "true"` stay strings (Task 1 tests "values that may be strings stay strings" and "quoted booleans become booleans only where the schema expects a boolean").
3. The user closes a session's window → the next call says `NO_SESSION_MESSAGE`, and `createIfEmpty` opens a fresh window (Task 6 test "closing the main window forgets the session").
4. A dialog in one session's tab is never reported to another session's call (dialog notes are taken only after the ownership check passes; Task 8 test "dialog reports are added only to calls that own the tab").
5. Claude's synthetic click at the Stop pill's position reaches the page, never the pill (Task 7 test "synthetic clicks look through the indicator's Stop pill to the page beneath").

---

### Task 1: Lenient arguments and a longer wait

**Files:**
- Create: `host/src/coerce.js`
- Modify: `host/src/mcp-server.js` (`callTool`, `runBatch`, new `callTimeout`)
- Modify: `host/src/tools.js` (`duration` schema)
- Modify: `extension/background/tools/computer.js` (`wait` limit)
- Test: `test/unit/coerce.test.js` (new), `test/unit/mcp-server.test.js`, `test/unit/computer.test.js`

**Interfaces:**
- Produces: `coerceArgs(schema, args)` → coerced args (same object shape; non-objects returned unchanged unless they parse to an object). `callTimeout(name, args)` → milliseconds. `callTool(bridge, name, args = {}, limitMs = Infinity)`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/coerce.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { coerceArgs } from "../../host/src/coerce.js";
import { TOOL_BY_NAME } from "../../host/src/tools.js";

const schemaOf = (name) => TOOL_BY_NAME.get(name).inputSchema;

test("JSON-encoded arrays and numeric strings become the arrays and numbers the schema asks for", () => {
  assert.deepEqual(coerceArgs(schemaOf("computer"), { action: "left_click", tabId: "12", coordinate: "[100, 200]" }), { action: "left_click", tabId: 12, coordinate: [100, 200] });
  assert.deepEqual(coerceArgs(schemaOf("computer"), { action: "zoom", tabId: 1, region: ["0", "0", "10", "10"] }).region, [0, 0, 10, 10]);
  assert.deepEqual(coerceArgs(schemaOf("file_upload"), { paths: '["/tmp/a.txt"]', ref: "ref_1", tabId: 1 }).paths, ["/tmp/a.txt"]);
});

test("quoted booleans become booleans only where the schema expects a boolean", () => {
  assert.equal(coerceArgs(schemaOf("tabs_context"), { createIfEmpty: "true" }).createIfEmpty, true);
  assert.equal(coerceArgs(schemaOf("read_console_messages"), { tabId: 1, onlyErrors: "false" }).onlyErrors, false);
  assert.equal(coerceArgs(schemaOf("computer"), { action: "type", tabId: 1, text: "true" }).text, "true");
});

test("values that may be strings stay strings", () => {
  assert.equal(coerceArgs(schemaOf("form_input"), { ref: "ref_1", value: "123", tabId: 1 }).value, "123");
  assert.equal(coerceArgs(schemaOf("form_input"), { ref: "ref_1", value: "true", tabId: 1 }).value, "true");
});

test("a whole argument object sent as JSON is parsed and invalid JSON is left alone", () => {
  assert.deepEqual(coerceArgs(schemaOf("navigate"), '{"url":"a.test","tabId":"3"}'), { url: "a.test", tabId: 3 });
  assert.equal(coerceArgs(schemaOf("computer"), { action: "left_click", tabId: 1, coordinate: "[1, 2" }).coordinate, "[1, 2");
  assert.equal(coerceArgs(schemaOf("computer"), { action: "scroll", tabId: 1, scroll_amount: "lots" }).scroll_amount, "lots");
  assert.equal(coerceArgs(schemaOf("navigate"), "not json"), "not json");
});

test("browser_batch actions and their inputs are parsed from JSON strings", () => {
  const actions = JSON.stringify([{ name: "computer", input: JSON.stringify({ action: "screenshot", tabId: "4" }) }]);
  assert.deepEqual(coerceArgs(schemaOf("browser_batch"), { actions }).actions, [{ name: "computer", input: { action: "screenshot", tabId: "4" } }]);
});
```

Append to `test/unit/mcp-server.test.js`:

```js
test("stringified coordinates and batch actions are coerced before reaching Firefox", async () => {
  const bridge = fakeBridge(() => ok("done"));
  await callTool(bridge, "computer", { action: "left_click", tabId: "3", coordinate: "[10, 20]" });
  assert.deepEqual(bridge.calls[0].args, { action: "left_click", tabId: 3, coordinate: [10, 20] });
  await callTool(bridge, "browser_batch", { actions: JSON.stringify([{ name: "navigate", input: { tabId: "3", url: "a.test" } }]) });
  assert.deepEqual(bridge.calls[1].args, { tabId: 3, url: "a.test" });
});

test("wait calls get their duration plus 10 s and other calls 30 s", async () => {
  const bridge = fakeBridge(() => ok("done"));
  await callTool(bridge, "computer", { action: "wait", duration: 30, tabId: 1 });
  await callTool(bridge, "computer", { action: "wait", duration: 2, tabId: 1 });
  await callTool(bridge, "computer", { action: "screenshot", tabId: 1 });
  assert.deepEqual(bridge.calls.map((c) => c.timeoutMs), [40_000, 30_000, 30_000]);
});
```

In `test/unit/computer.test.js` replace the line `await assert.rejects(run({ action: "wait", duration: 11 }), /between 0 and 10/);` with:

```js
  await assert.rejects(run({ action: "wait", duration: 31 }), /between 0 and 30/);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../host/src/coerce.js'`, and the computer test fails on `duration: 31`.

- [ ] **Step 3: Implement**

Create `host/src/coerce.js`:

```js
// Models sometimes send JSON-encoded strings or quoted numbers and booleans. Values are converted
// only to the type the schema asks for; anything that does not convert cleanly is left as sent.
export function coerceArgs(schema, args) {
  const value = parseJson(args, isObject);
  if (!isObject(value)) return value;
  const out = { ...value };
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (key in out) out[key] = coerceValue(prop, out[key]);
  }
  return out;
}

function coerceValue(prop, value) {
  const types = [].concat(prop?.type ?? []);
  if (typeof value === "string" && types.includes("string")) return value;
  if (types.includes("array")) {
    const parsed = parseJson(value, Array.isArray);
    return Array.isArray(parsed) && prop.items ? parsed.map((item) => coerceValue(prop.items, item)) : parsed;
  }
  if (types.includes("object")) {
    const parsed = parseJson(value, isObject);
    return isObject(parsed) && prop.properties ? coerceArgs(prop, parsed) : parsed;
  }
  if (types.includes("boolean") && (value === "true" || value === "false")) return value === "true";
  if ((types.includes("number") || types.includes("integer")) && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function parseJson(value, accept) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return accept(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
```

In `host/src/mcp-server.js`:
- add `import { coerceArgs } from "./coerce.js";` next to the other local imports;
- replace `callTool` and the `callTool(...)` line inside `runBatch`:

```js
export const callTimeout = (name, args) => (name === "computer" && args.action === "wait" ? Math.max(CALL_TIMEOUT_MS, Number(args.duration) * 1000 + 10_000 || 0) : CALL_TIMEOUT_MS);

export async function callTool(bridge, name, rawArgs = {}, limitMs = Infinity) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const args = coerceArgs(tool.inputSchema, rawArgs ?? {});
  const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined);
  if (missing.length) throw new Error(`${name}: missing required argument(s): ${missing.join(", ")}`);
  const timeoutMs = Math.min(callTimeout(name, args), limitMs);
  if (name === "browser_batch") return runBatch(bridge, args.actions);
  if (name === "file_upload") return bridge.call(name, await withFileContents(args), timeoutMs);
  return bridge.call(name, args, timeoutMs);
}
```

and in `runBatch` change `result = await callTool(bridge, name, action.input ?? {}, Math.min(CALL_TIMEOUT_MS, remaining));` to:

```js
      result = await callTool(bridge, name, action.input ?? {}, remaining);
```

In `host/src/tools.js` change the `duration` property to:

```js
        duration: { type: "number", minimum: 0, maximum: 30, description: "Seconds to wait (wait action), up to 30." },
```

In `extension/background/tools/computer.js`, in `case "wait"`, change the check and message to:

```js
        if (!(seconds > 0 && seconds <= 30)) throw new Error("wait: duration must be between 0 and 30 seconds");
```

If an existing `mcp-server.test.js` test passed an explicit timeout as `callTool`'s fourth argument, keep its intent: the fourth argument is now an upper limit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run lint`
Expected: all tests pass; lint reports no errors (the existing Android warning is fine).

- [ ] **Step 5: Commit**

```bash
git add host/src/coerce.js host/src/mcp-server.js host/src/tools.js extension/background/tools/computer.js test/unit/coerce.test.js test/unit/mcp-server.test.js test/unit/computer.test.js
git commit -m "Coerce loosely typed tool arguments and allow 30 s waits"
```

---

### Task 2: Richer read_page and our own page-text and redaction strings

**Files:**
- Modify: `extension/content/tree.js` (`REDACTED`, `describe`, new `expandedState`)
- Modify: `extension/background/tree.js` (`renderNode`)
- Modify: `extension/content/text.js`
- Test: `test/unit/tree.test.js`, `test/unit/form.test.js` (page-text tests live there)

**Interfaces:**
- Produces: tree nodes may carry `expanded: boolean`, `selected: true`, `pressed: true`; `href` is absolute for links.

- [ ] **Step 1: Write the failing tests**

In `test/unit/tree.test.js`:
- change the `href="\/home"` expectation in the first test to `href="https:\/\/example.test\/home"`;
- change `/value="\[value redacted\]"/g` to `/value="\(sensitive value hidden\)"/g` and `/combobox "\[value redacted\]" \[ref_\d+\]/` to `/combobox "\(sensitive value hidden\)" \[ref_\d+\]/`;
- append:

```js
test("expanded, collapsed, selected and pressed states are shown", () => {
  const w = loadContent(`<button aria-expanded="false">Menu</button><button aria-expanded="true">Open menu</button>
    <div role="tab" aria-selected="true">Overview</div><button aria-pressed="true">Bold</button>
    <details open><summary>More</summary><p>Hidden text</p></details><details><summary>Less</summary></details>`);
  const text = render(w);
  assert.match(text, /button "Menu" \[ref_\d+\] \(collapsed\)/);
  assert.match(text, /button "Open menu" \[ref_\d+\] \(expanded\)/);
  assert.match(text, /tab "Overview" \[ref_\d+\] \(selected\)/);
  assert.match(text, /button "Bold" \[ref_\d+\] \(pressed\)/);
  assert.match(text, /button "More" \[ref_\d+\] \(expanded\)/);
  assert.match(text, /button "Less" \[ref_\d+\] \(collapsed\)/);
});

test("links show their resolved absolute URL", () => {
  const w = loadContent(`<a href="../docs/start?x=1#top">Start</a><a href="https://other.test/">Other</a>`, ["tree.js"], { url: "https://example.test/app/page" });
  const text = render(w);
  assert.match(text, /link "Start" \[ref_\d+\] href="https:\/\/example\.test\/docs\/start\?x=1#top"/);
  assert.match(text, /link "Other" \[ref_\d+\] href="https:\/\/other\.test\/"/);
});
```

In `test/unit/form.test.js` append:

```js
test("page text uses main or role=main when it is the longest content element", () => {
  const w = loadContent(`<nav>Site navigation</nav><div role="main">The main region holds the most text here</div><article>Short</article>`, FILES);
  const page = w.__cf.text.pageText();
  assert.equal(page.tag, "div");
  assert.equal(page.text, "The main region holds the most text here");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL on the new state, href, redaction and role=main assertions.

- [ ] **Step 3: Implement**

In `extension/content/tree.js`:
- `const REDACTED = "(sensitive value hidden)";`
- add after `nameOf`:

```js
  function expandedState(el) {
    const aria = el.getAttribute("aria-expanded");
    if (aria === "true" || aria === "false") return aria === "true";
    const parent = tagOf(el) === "SUMMARY" ? el.parentElement : null;
    return parent && tagOf(parent) === "DETAILS" ? parent.open : null;
  }
```

- replace `describe` with:

```js
  function describe(el, role, name, level, prefix, interactive) {
    const node = { level, role, ref: refFor(el, prefix) };
    if (name) node.name = name;
    if (interactive) node.interactive = true;
    if (el.checked === true || el.getAttribute("aria-checked") === "true") node.checked = true;
    const expanded = expandedState(el);
    if (expanded != null) node.expanded = expanded;
    if (el.getAttribute("aria-selected") === "true") node.selected = true;
    if (el.getAttribute("aria-pressed") === "true") node.pressed = true;
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") node.disabled = true;
    for (const attr of ["href", "type", "placeholder"]) {
      let value = el.getAttribute(attr);
      // SVG links expose href as an SVGAnimatedString, so only string hrefs are resolved.
      if (attr === "href" && value && typeof el.href === "string") value = el.href;
      if (value && !(attr === "placeholder" && value === name)) node[attr] = clean(value, 200);
    }
    const value = fieldValue(el);
    if (value != null) node.value = value;
    return node;
  }
```

In `extension/background/tree.js` replace the state lines of `renderNode` (from `if (node.checked)` through `if (node.disabled)`) with:

```js
  if (node.checked) line += " (checked)";
  if (node.selected) line += " (selected)";
  if (node.expanded === true) line += " (expanded)";
  if (node.expanded === false) line += " (collapsed)";
  if (node.pressed) line += " (pressed)";
  if (node.disabled) line += " (disabled)";
```

Replace `extension/content/text.js` with:

```js
(() => {
  if (globalThis.__cf?.text) return;
  const cf = (globalThis.__cf ??= {});
  const CONTENT = "main, [role=main], article";

  function pageText() {
    const longest = [...document.querySelectorAll(CONTENT)].reduce((best, el) => (!best || el.innerText.length > best.innerText.length ? el : best), null);
    const source = longest ?? document.body;
    const text = source.innerText.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { title: document.title, url: location.href, tag: source.tagName.toLowerCase(), text };
  }

  cf.text = { pageText };
})();
```

Update `host/src/tools.js` `read_page` description: replace `Password and payment field values are redacted.` with `Password, one-time-code and payment field values are hidden. Lines show states such as (checked), (selected), (expanded), (collapsed), (pressed) and (disabled), and links show absolute URLs.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/content/tree.js extension/background/tree.js extension/content/text.js host/src/tools.js test/unit/tree.test.js test/unit/form.test.js
git commit -m "Show expanded, selected and pressed states and absolute links in read_page"
```

---

### Task 3: form_input on wrappers and our own form messages

**Files:**
- Modify: `extension/content/form.js`
- Modify: `host/src/tools.js` (`form_input` description)
- Test: `test/unit/form.test.js`

**Interfaces:**
- Produces: `cf.form.setValue({ ref, value, guard })` accepts wrapper refs. Messages listed in Step 3.

- [ ] **Step 1: Write the failing tests**

In `test/unit/form.test.js`:
- replace `/Option "Japan" not found\. Available options: "United States" \(value: "us"\), "Korea" \(value: "kr"\)/` with `/No option matches "Japan"\. Options: "United States" = "us"; "Korea" = "kr"/`;
- replace `/Checkbox requires a boolean value/` with `/A checkbox needs true or false/`;
- replace `"Set password value to [redacted] (previous: [redacted])"` with `"Set password value to (hidden) (previous: (hidden))"`;
- replace `"Selected [redacted] (previous: [redacted])"` with `"Selected an option (sensitive field; values hidden)"`;
- if a test asserts the sensitive-select miss message, change it to `/No option matches \(options of a sensitive field are not listed\)/`;
- append:

```js
test("a ref to a wrapper uses the single control inside it, including one in a shadow root", () => {
  const w = loadContent(`<div role="group" aria-label="Nickname field"><span>Nickname</span><input id="nick"></div><x-field id="custom" role="group" aria-label="Custom field"></x-field>`, FILES);
  w.document.getElementById("custom").attachShadow({ mode: "open" }).innerHTML = `<input id="inner">`;
  assert.match(set(w, "Nickname field", "Ada"), /^Set text value to "Ada" \(previous: ""\) \(used the <input> inside ref_\d+\)$/);
  assert.equal(w.document.getElementById("nick").value, "Ada");
  set(w, "Custom field", "Bo");
  assert.equal(w.document.getElementById("custom").shadowRoot.getElementById("inner").value, "Bo");
});

test("a wrapper with several controls asks for one of them", () => {
  const w = loadContent(`<div role="group" aria-label="Name fields"><input aria-label="First"><input aria-label="Last"></div>`, FILES);
  assert.throws(() => set(w, "Name fields", "x"), /ref_\d+ contains 2 form controls; pass the ref of one of them/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL on the reworded messages and the wrapper tests.

- [ ] **Step 3: Implement**

Replace the body of `extension/content/form.js` from `const fire = ...` through the end of `selectOption` with:

```js
  const CONTROL = 'input:not([type="hidden"]), select, textarea, [contenteditable]:not([contenteditable="false"])';

  const fire = (el, type) => el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));

  function controlsInside(root) {
    const found = [];
    const visit = (node) => {
      const shadow = node.openOrClosedShadowRoot ?? node.shadowRoot;
      for (const child of [...(shadow?.children ?? []), ...node.children]) {
        if (child.matches(CONTROL)) found.push(child);
        else visit(child);
      }
    };
    visit(root);
    return found;
  }

  // Widgets often wrap the real control in a label, a field container or a shadow root.
  function controlFor(el, ref) {
    if (el.matches(CONTROL)) return el;
    const inside = controlsInside(el);
    if (inside.length > 1) throw new Error(`${ref} contains ${inside.length} form controls; pass the ref of one of them`);
    return inside[0] ?? el;
  }

  function setValue({ ref, value, guard }) {
    const target = cf.tree.resolve(ref);
    const el = controlFor(target, ref);
    cf.dom.guardHost(guard);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const result = applyValue(el, value);
    return el === target ? result : `${result} (used the <${el.tagName.toLowerCase()}> inside ${ref})`;
  }

  function applyValue(el, value) {
    const tag = el.tagName.toUpperCase();
    const type = tag === "INPUT" ? el.type : "";
    const sensitive = cf.tree.isSensitive(el);
    const show = (v) => (sensitive ? "(hidden)" : JSON.stringify(String(v)));

    if (tag === "SELECT") return selectOption(el, value, sensitive);
    if (type === "checkbox") {
      if (typeof value !== "boolean") throw new Error("A checkbox needs true or false");
      const previous = el.checked;
      if (previous !== value) el.click();
      return `Set checkbox to ${el.checked} (previous: ${previous})`;
    }
    if (type === "radio") {
      if (!el.checked) el.click();
      return `Selected radio ${JSON.stringify(el.value)}`;
    }
    if (type === "file") throw new Error("Use file_upload for file inputs");
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const text = String(value);
      if (NUMERIC.has(type) && text !== "" && !Number.isFinite(Number(text))) throw new Error(`A ${type} input needs a numeric value`);
      const previous = el.value;
      el.focus();
      cf.dom.setNativeValue(el, text);
      fire(el, "input");
      fire(el, "change");
      return `Set ${type || "textarea"} value to ${show(el.value)} (previous: ${show(previous)})`;
    }
    if (cf.dom.isContentEditable(el)) {
      const previous = el.textContent;
      const doc = el.ownerDocument;
      el.focus();
      const range = doc.createRange();
      range.selectNodeContents(el);
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (!doc.execCommand("insertText", false, String(value))) {
        el.textContent = String(value);
        fire(el, "input");
      }
      return `Set editable content to ${show(el.textContent)} (previous: ${show(previous)})`;
    }
    throw new Error(`<${tag.toLowerCase()}> is not a supported form input`);
  }

  function selectOption(el, value, sensitive) {
    const wanted = String(value);
    const options = [...el.options];
    const option = options.find((o) => o.value === wanted)
      ?? options.find((o) => o.text === wanted)
      ?? options.find((o) => o.text.trim().toLowerCase() === wanted.trim().toLowerCase());
    if (!option && sensitive) throw new Error("No option matches (options of a sensitive field are not listed)");
    if (!option) throw new Error(`No option matches "${wanted}". Options: ${options.map((o) => `"${o.text.trim()}" = "${o.value}"`).join("; ")}`);
    const previous = el.selectedOptions[0]?.text.trim() ?? "";
    el.focus();
    option.selected = true;
    fire(el, "input");
    fire(el, "change");
    if (sensitive) return "Selected an option (sensitive field; values hidden)";
    return `Selected "${option.text.trim()}" (previous: "${previous}")`;
  }
```

Keep `NUMERIC`, `setFiles` and the `cf.form = { setValue, setFiles };` line as they are.

In `host/src/tools.js` append to the `form_input` description: ` A ref to a wrapper such as a label or field container uses the single control inside it.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/content/form.js host/src/tools.js test/unit/form.test.js
git commit -m "Let form_input target wrappers around a single control"
```

---

### Task 4: Console stack traces

**Files:**
- Modify: `extension/content/console-hook.js`
- Test: `test/unit/console-hook.test.js`

**Interfaces:**
- Produces: `cf.consoleHook.format(value)` appends up to 10 indented stack lines for a top-level Error argument.

- [ ] **Step 1: Write the failing tests**

In `test/unit/console-hook.test.js` replace `assert.equal(format(new TypeError("bad")), "TypeError: bad");` with:

```js
  assert.match(format(new TypeError("bad")), /^TypeError: bad\n {4}\S/);
  assert.equal(format({ e: new TypeError("inner") }), '{"e":TypeError: inner}');
```

and append:

```js
test("error stacks are limited to 10 lines and an unreadable stack is skipped", () => {
  const { format } = hook();
  const deep = new Error("deep");
  deep.stack = ["Error: deep", ...Array.from({ length: 15 }, (_, i) => `f${i}@https://a.test/app.js:${i}:1`)].join("\n");
  const lines = format(deep).split("\n");
  assert.equal(lines[0], "Error: deep");
  assert.equal(lines.length, 11);
  assert.equal(lines[1], "    Error: deep");
  const sealed = new Error("sealed");
  Object.defineProperty(sealed, "stack", { get() { throw new Error("no"); } });
  assert.equal(format(sealed), "Error: sealed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — no stack lines in the output.

- [ ] **Step 3: Implement**

In `extension/content/console-hook.js` add `const MAX_STACK_LINES = 10;` after `MAX_QUEUE`, and after `dataProp` add:

```js
  const isError = (value) => typeof value === "object" && value !== null && Object.prototype.toString.call(value) === "[object Error]";

  // Page errors arrive through Xrays, which expose only the native stack accessor, never a page-defined getter.
  const stackOf = (error) => {
    let stack;
    try {
      stack = error.stack;
    } catch {
      return "";
    }
    if (typeof stack !== "string" || !stack.trim()) return "";
    return `\n${stack.trim().split("\n").slice(0, MAX_STACK_LINES).map((line) => `    ${line.trim()}`).join("\n")}`;
  };
```

Change `format` to:

```js
  const format = (value) => {
    try {
      if (typeof value === "string") return value;
      if (typeof value === "function") return String(value);
      const text = walk(value, 0, new Set(), { left: MAX_TEXT });
      return isError(value) ? `${text}${stackOf(value)}` : text;
    } catch {
      try {
        return String(value);
      } catch {
        return "[unprintable]";
      }
    }
  };
```

Change the `error` listener to:

```js
  window.addEventListener("error", (event) => record("exception", `${event.message} (${event.filename}:${event.lineno}:${event.colno})${event.error ? stackOf(event.error) : ""}`));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/content/console-hook.js test/unit/console-hook.test.js
git commit -m "Include stack traces in console errors"
```

---

### Task 5: Wait for navigations started by actions

**Files:**
- Create: `extension/background/navigation.js` (moved `waitForNavigation`, `tabShowing`, `framesSettled`; new `watchNavigation`)
- Modify: `extension/background/tools/tabs.js` (import from `../navigation.js`, pass `signal`)
- Modify: `extension/background/tools/computer.js` (settle, hover settle, abortable sleep, `signal`)
- Modify: `host/src/tools.js` (`computer` description)
- Test: `test/unit/navigation.test.js` (new), `test/unit/tabs.test.js`, `test/unit/computer.test.js`

**Interfaces:**
- Produces: `watchNavigation(api, tabId, { signal, startMs = 500, loadMs = 10_000 })` → `{ settle(): Promise<string>, stop(): void }`. `settle()` returns `""`, `"→ URL changed to <url>"`, `"→ Navigated to <url> — \"<title>\""` or `"→ Still loading after 10s: <url>"`. `waitForNavigation(api, tabId, timeoutMs, acceptBlank, signal)`. `framesSettled(api, tabId)`. `computerTool({ api, content, capture, watch = watchNavigation })`; tools' `run` now receives `{ tab, args, signal }`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/navigation.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { framesSettled, watchNavigation } from "../../extension/background/navigation.js";

function fakeApi({ tab = { id: 1, url: "https://b.test/", title: "B", status: "complete" } } = {}) {
  const listeners = {};
  const event = (name) => {
    listeners[name] = new Set();
    return { addListener: (l) => listeners[name].add(l), removeListener: (l) => listeners[name].delete(l) };
  };
  const api = {
    webNavigation: {
      onBeforeNavigate: event("before"), onCompleted: event("completed"), onErrorOccurred: event("error"),
      onHistoryStateUpdated: event("history"), onReferenceFragmentUpdated: event("fragment"),
      getAllFrames: async () => [],
    },
    tabs: { get: async () => tab, executeScript: async () => [0] },
  };
  const fire = (name, details) => { for (const l of [...listeners[name]]) l({ tabId: 1, frameId: 0, ...details }); };
  const live = () => Object.values(listeners).reduce((n, set) => n + set.size, 0);
  return { api, fire, live };
}

test("no navigation within the start window settles with no suffix and stops listening", async () => {
  const { api, live } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 20 });
  assert.equal(await watch.settle(), "");
  assert.equal(live(), 0);
});

test("a load that starts and completes reports the final URL and title", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50 });
  fire("before", { url: "https://b.test/" });
  setTimeout(() => fire("completed", { url: "https://b.test/" }), 5);
  assert.equal(await watch.settle(), '→ Navigated to https://b.test/ — "B"');
});

test("process-switch aborts are ignored and other frames do not count", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50 });
  fire("before", { url: "https://b.test/", frameId: 4 });
  fire("before", { url: "https://b.test/" });
  fire("error", { url: "https://b.test/", error: "NS_BINDING_ABORTED" });
  setTimeout(() => fire("completed", { url: "https://b.test/" }), 5);
  assert.equal(await watch.settle(), '→ Navigated to https://b.test/ — "B"');
});

test("same-document changes are reported without waiting for a load", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50 });
  fire("history", { url: "https://a.test/next" });
  assert.equal(await watch.settle(), "→ URL changed to https://a.test/next");
});

test("a load that does not finish in time is reported as still loading", async () => {
  const { api, fire } = fakeApi();
  const watch = watchNavigation(api, 1, { startMs: 50, loadMs: 20 });
  fire("before", { url: "https://slow.test/" });
  assert.equal(await watch.settle(), "→ Still loading after 0.02s: https://slow.test/");
});

test("an abort signal ends the wait early", async () => {
  const { api, fire } = fakeApi();
  const controller = new AbortController();
  const watch = watchNavigation(api, 1, { signal: controller.signal, startMs: 50, loadMs: 60_000 });
  fire("before", { url: "https://slow.test/" });
  setTimeout(() => controller.abort(), 5);
  const started = Date.now();
  await watch.settle();
  assert.ok(Date.now() - started < 1000);
});

test("framesSettled waits until the child frame is registered", async () => {
  const polls = [[{ frameId: 0, parentFrameId: -1 }], [{ frameId: 0, parentFrameId: -1 }, { frameId: 7, parentFrameId: 0 }]];
  let calls = 0;
  const api = { tabs: { executeScript: async () => [1] }, webNavigation: { getAllFrames: async () => polls[Math.min(calls++, polls.length - 1)] } };
  await framesSettled(api, 1);
  assert.equal(calls, 2);
});
```

In `test/unit/tabs.test.js` change the import to `import { withScheme } from "../../extension/background/tools/tabs.js";` plus `import { framesSettled } from "../../extension/background/navigation.js";`.

In `test/unit/computer.test.js`:
- change `setup` to accept a watcher and pass it, and make `run` accept a signal:

```js
function setup(replies = {}, { suffix = "" } = {}) {
```

and replace `const { computer } = computerTool({ api, content, capture });` and the return line with:

```js
  const watched = [];
  const watch = (_api, tabId) => {
    const watcher = { tabId, stopped: false, settle: async () => suffix, stop() { watcher.stopped = true; } };
    watched.push(watcher);
    return watcher;
  };
  const { computer } = computerTool({ api, content, capture, watch });
  const tab = { id: 1, url: "https://a.test/", windowId: 3, groupId: 9 };
  return { run: (args, signal) => computer.run({ tab, args, signal }), calls, created, grouped, watched };
```

- append:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `navigation.js` does not exist; `computerTool` ignores `watch`.

- [ ] **Step 3: Implement**

Create `extension/background/navigation.js` by moving `tabShowing`, `framesSettled` and `waitForNavigation` (with their comments) out of `extension/background/tools/tabs.js`, exporting all three, and adding the abort signal to `waitForNavigation`:

```js
export const SETTLE_START_MS = 500;
export const SETTLE_LOAD_MS = 10_000;

// The tab's url and title update shortly after the webNavigation events that report the load.
export async function tabShowing(api, tabId, url) {
  let tab = await api.tabs.get(tabId);
  for (let waited = 0; waited < 2000 && (tab.url !== url || tab.status !== "complete"); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    tab = await api.tabs.get(tabId);
  }
  return tab;
}

// Out-of-process iframes register their frame ids after the top-level load event.
export async function framesSettled(api, tabId) {
  const counted = await api.tabs.executeScript(tabId, { frameId: 0, code: 'document.querySelectorAll("iframe, frame").length' }).catch(() => null);
  const expected = counted?.[0];
  if (!(expected > 0)) return;
  for (let waited = 0; waited < 1000; waited += 50) {
    const frames = await api.webNavigation.getAllFrames({ tabId }).catch(() => null);
    if (!frames || frames.filter((f) => f.parentFrameId === 0).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function waitForNavigation(api, tabId, timeoutMs, acceptBlank, signal) {
  const { onBeforeNavigate, onCompleted, onErrorOccurred, onHistoryStateUpdated, onReferenceFragmentUpdated } = api.webNavigation;
  return new Promise((resolve) => {
    // Events from the page loaded before this navigation can still be in flight (a new tab's about:blank load), so loads only count after their onBeforeNavigate and a blank page only counts when blank was requested. Firefox aborts and restarts the load when it switches process, reporting NS_BINDING_ABORTED in between.
    let started = false;
    const mine = (details) => details.tabId === tabId && details.frameId === 0 && (acceptBlank || details.url !== "about:blank");
    const onStart = (details) => { if (mine(details)) started = true; };
    const onSameDocument = (details) => { if (mine(details)) finish(details.url); };
    const onLoadEnd = (details) => { if (started && mine(details)) finish(details.url); };
    const onError = (details) => { if (details.error !== "NS_BINDING_ABORTED") onLoadEnd(details); };
    const onAbort = () => finish(null);
    const listeners = [[onBeforeNavigate, onStart], [onHistoryStateUpdated, onSameDocument], [onReferenceFragmentUpdated, onSameDocument], [onCompleted, onLoadEnd], [onErrorOccurred, onError]];
    const finish = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const [event, listener] of listeners) event.removeListener(listener);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    for (const [event, listener] of listeners) event.addListener(listener);
    if (signal?.aborted) finish(null);
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Listening starts before the action runs, so a navigation the action triggers synchronously is not missed.
export function watchNavigation(api, tabId, { signal, startMs = SETTLE_START_MS, loadMs = SETTLE_LOAD_MS } = {}) {
  const { onBeforeNavigate, onCompleted, onErrorOccurred, onHistoryStateUpdated, onReferenceFragmentUpdated } = api.webNavigation;
  let started = null;
  let finished = null;
  let sameDocument = null;
  let wake = () => {};
  const top = (details) => details.tabId === tabId && details.frameId === 0;
  const onSameDocument = (details) => { if (top(details)) { sameDocument = details.url; wake(); } };
  const listeners = [
    [onBeforeNavigate, (details) => { if (top(details) && details.url !== "about:blank") { started = details.url; wake(); } }],
    [onHistoryStateUpdated, onSameDocument],
    [onReferenceFragmentUpdated, onSameDocument],
    [onCompleted, (details) => { if (top(details) && started) { finished = details.url; wake(); } }],
    [onErrorOccurred, (details) => { if (top(details) && started && details.error !== "NS_BINDING_ABORTED") { finished = details.url; wake(); } }],
  ];
  for (const [event, listener] of listeners) event.addListener(listener);
  const stop = () => { for (const [event, listener] of listeners) event.removeListener(listener); };

  const until = (ready, ms) => new Promise((resolve) => {
    if (ready() || signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      wake = () => {};
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wake = () => { if (ready()) done(); };
    signal?.addEventListener("abort", done, { once: true });
  });

  return {
    stop,
    async settle() {
      try {
        await until(() => started || sameDocument, startMs);
        if (!started) return sameDocument ? `→ URL changed to ${sameDocument}` : "";
        await until(() => finished, loadMs);
        if (!finished) return `→ Still loading after ${loadMs / 1000}s: ${started}`;
        const tab = await tabShowing(api, tabId, finished);
        await framesSettled(api, tabId);
        return `→ Navigated to ${tab.url} — "${tab.title}"`;
      } finally {
        stop();
      }
    },
  };
}
```

In `extension/background/tools/tabs.js`:
- add `import { framesSettled, tabShowing, waitForNavigation } from "../navigation.js";` and delete the moved functions;
- change the `navigate` tool to `run: ({ tab, args, signal }) => navigate(api, tab, args.url, signal),`;
- change `async function navigate(api, tab, url)` to `async function navigate(api, tab, url, signal)` and its wait to `waitForNavigation(api, tab.id, NAVIGATION_TIMEOUT_MS, url === "back" || url === "forward" || url.trim() === "about:blank", signal)`.

In `extension/background/tools/computer.js`:
- add `import { watchNavigation } from "../navigation.js";`;
- replace the `sleep` constant and add constants:

```js
const SETTLING = new Set(["left_click", "right_click", "double_click", "triple_click", "type", "key"]);
const HOVER_SETTLE_MS = 300;
const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});
```

- change the signature to `export function computerTool({ api, content, capture, watch = watchNavigation }) {`;
- rename the existing `async function run({ tab, args })` to `async function perform(tab, args, signal)` (same body), with these changes inside it: the `wait` case calls `await sleep(seconds * 1000, signal);`; the `hover` case awaits `sleep(HOVER_SETTLE_MS, signal)` after `moveCursor` and before returning;
- add the new `run` after `perform`:

```js
  async function run({ tab, args, signal }) {
    if (!SETTLING.has(args.action)) return perform(tab, args, signal);
    const navigation = watch(api, tab.id, { signal });
    let result;
    try {
      result = await perform(tab, args, signal);
    } catch (err) {
      navigation.stop();
      throw err;
    }
    const suffix = await navigation.settle();
    return suffix ? `${result} ${suffix}` : result;
  }
```

In `host/src/tools.js` add one bullet to the `computer` description array, after the "Click the center of elements." line:

```js
      "* Clicks, type and key wait up to 0.5 s for a navigation to start and then up to 10 s for it to finish, and report where the page went.",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS. The hover test in `computer.test.js` now takes 300 ms; that is expected.

- [ ] **Step 5: Commit**

```bash
git add extension/background/navigation.js extension/background/tools/tabs.js extension/background/tools/computer.js host/src/tools.js test/unit/navigation.test.js test/unit/tabs.test.js test/unit/computer.test.js
git commit -m "Wait for navigations started by clicks, typing and keys"
```

---
### Task 6: Sessions own windows

**Files:**
- Rewrite: `extension/background/sessions.js`
- Modify: `extension/background/dispatch.js` (activate the tab, append tab-change notes, async `close`)
- Modify: `extension/background/tools/tabs.js` (`tabs_context` fallback text)
- Modify: `extension/background/tools/computer.js` (new-tab links stay in the clicked tab's window)
- Modify: `extension/background/main.js` (`windows.onRemoved`)
- Modify: `extension/manifest.json` (`sessions` permission)
- Modify: `host/src/tools.js` (descriptions)
- Test: `test/unit/sessions.test.js` (rewrite), `test/unit/dispatch.test.js`, `test/unit/computer.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (`createSessions(api)` returns): `context(sessionId, { createIfEmpty })` → `{ availableTabs, windowId } | null`; `createTab(sessionId)`; `ownedTab(sessionId, tabId)`; `activate(tab)`; `adoptOpened(tab)`; `sessionOfTab(tab)` → `sessionId | null`; `sessionTabs(sessionId)` → tabs; `isStopped(sessionId)`; `setStopped(sessionId, stopped)`; `setStatus(sessionId, "busy" | "idle")`; `tabChanges(sessionId)` → `string`; `windowRemoved(windowId)`; `close(sessionId)` (async). Exported `NO_SESSION_MESSAGE`.

- [ ] **Step 1: Write the failing tests**

Replace `test/unit/sessions.test.js` with:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { NO_SESSION_MESSAGE, createSessions } from "../../extension/background/sessions.js";

function fakeApi({ groups: groupsEnabled = true } = {}) {
  let nextTab = 1;
  let nextWindow = 10;
  let nextGroup = 100;
  const tabs = new Map();
  const windows = new Map();
  const groups = new Map();
  const values = new Map();
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
      getAll: async () => [...windows.values()].map((w) => ({ ...w })),
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
  const closeWindow = (id) => {
    windows.delete(id);
    for (const t of [...tabs.values()]) if (t.windowId === id) tabs.delete(t.id);
  };
  return { api, tabs, windows, groups, values, addTab, addWindow, closeWindow };
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
```

In `test/unit/dispatch.test.js`:
- change `setup` so the sessions fake has the new methods:

```js
function setup(tools, ownedTab = async (_sessionId, tabId) => ({ id: tabId, url: "https://example.test/", active: true }), { changes = "" } = {}) {
  const sent = [];
  const closed = [];
  const events = [];
  const activated = [];
  const activity = { start: (id) => events.push(["start", id]), end: (id) => events.push(["end", id]) };
  const sessions = { ownedTab, activate: async (tab) => activated.push(tab.id), tabChanges: async () => changes, close: async (id) => closed.push(id) };
  return { dispatch: createDispatcher({ tools, sessions, activity, send: (m) => sent.push(m) }), sent, closed, events, activated };
}
```

- change the ownership-failure message in the existing test to `"Tab 9 is not in this session's window. Valid tab IDs: 5"`;
- append:

```js
test("the owned tab is made active before the tool runs", async () => {
  const { dispatch, activated } = setup({ look: { tabScoped: true, run: async () => "ok" } });
  await dispatch(call("look", { tabId: 5 }));
  assert.deepEqual(activated, [5]);
});

test("tab changes are appended to results except tabs_context, which lists every tab", async () => {
  const tools = { look: { tabScoped: false, run: async () => "ok" }, tabs_context: { tabScoped: false, run: async () => "{}" } };
  const { dispatch, sent } = setup(tools, undefined, { changes: "Tabs changed: closed 3" });
  await dispatch(call("look"));
  await dispatch(call("tabs_context"));
  assert.deepEqual(sent[0].content, [{ type: "text", text: "ok" }, { type: "text", text: "Tabs changed: closed 3" }]);
  assert.deepEqual(sent[1].content, [{ type: "text", text: "{}" }]);
});
```

In `test/unit/computer.test.js` replace the test `"links that would open a new tab are opened inside the session's group"` with:

```js
test("links that would open a new tab open in the clicked tab's window", async () => {
  const { run, created, grouped } = setup({ "0:input.click": { opened: ["https://b.test/"], point: { x: 1, y: 2 } } });
  assert.equal(await run({ action: "left_click", ref: "ref_4" }), "Clicked ref_4 (link opened in new tab 51)");
  assert.deepEqual(created, [{ url: "https://b.test/", openerTabId: 1, windowId: 3, active: false }]);
  assert.deepEqual(grouped, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `NO_SESSION_MESSAGE` is not exported, windows are not created, dispatcher does not call `activate`.

- [ ] **Step 3: Implement**

Replace `extension/background/sessions.js` with:

```js
const COLORS = ["orange", "blue", "green", "purple", "cyan", "pink", "yellow", "red"];
const KEY = "claudeSession";
const STATUS_PREFIX = { new: "", busy: "⌛ ", idle: "✅ " };
export const NO_SESSION_MESSAGE = "This session has no window yet. Call tabs_context with createIfEmpty: true first.";

export function createSessions(api) {
  const records = new Map();
  const creating = new Map();
  let nextColor = 0;

  const tagOf = (sessionId) => `Claude · ${sessionId.slice(0, 8)}`;
  const labelOf = (rec) => `${rec.stopped ? "⏸ " : STATUS_PREFIX[rec.status]}${tagOf(rec.id)}`;

  function newRecord(sessionId) {
    return { id: sessionId, main: null, windows: new Set(), groupId: null, color: COLORS[nextColor++ % COLORS.length], status: "new", stopped: false, known: null };
  }

  async function applyLabel(rec) {
    const label = labelOf(rec);
    await api.windows.update(rec.main, { titlePreface: `${label} — ` }).catch(() => {});
    if (rec.groupId != null) await api.tabGroups.update(rec.groupId, { title: label, color: rec.color }).catch(() => {});
  }

  const persist = (rec, windowId) => api.sessions.setWindowValue(windowId, KEY, { sessionId: rec.id, role: windowId === rec.main ? "main" : "popup", stopped: rec.stopped });

  async function tabsOf(rec) {
    const lists = await Promise.all([...rec.windows].map((windowId) => api.tabs.query({ windowId })));
    return lists.flat();
  }

  // Window values survive add-on reloads and Firefox restarts, unlike this background page's memory.
  async function recover(sessionId) {
    const rec = newRecord(sessionId);
    for (const win of await api.windows.getAll()) {
      const value = await api.sessions.getWindowValue(win.id, KEY).catch(() => undefined);
      if (value?.sessionId !== sessionId) continue;
      rec.windows.add(win.id);
      if (value.role === "main") rec.main = win.id;
      if (value.stopped) rec.stopped = true;
    }
    if (rec.main == null) return null;
    const groups = await api.tabGroups.query({ windowId: rec.main }).catch(() => []);
    rec.groupId = groups.find((g) => g.title?.endsWith(tagOf(sessionId)))?.id ?? null;
    records.set(sessionId, rec);
    return rec;
  }

  async function find(sessionId) {
    const rec = records.get(sessionId);
    if (!rec) return recover(sessionId);
    if (await api.windows.get(rec.main).then(() => true, () => false)) return rec;
    records.delete(sessionId);
    return null;
  }

  async function create(sessionId) {
    const win = await api.windows.create({ url: "about:blank", focused: false });
    const rec = newRecord(sessionId);
    rec.main = win.id;
    rec.windows.add(win.id);
    records.set(sessionId, rec);
    await persist(rec, win.id);
    rec.groupId = await api.tabs.group({ tabIds: win.tabs.map((t) => t.id), createProperties: { windowId: win.id } }).catch(() => null);
    await applyLabel(rec);
    return rec;
  }

  function recordOfWindow(windowId) {
    for (const rec of records.values()) if (rec.windows.has(windowId)) return rec;
    return null;
  }

  return {
    async context(sessionId, { createIfEmpty = false } = {}) {
      let rec = await find(sessionId);
      if (!rec) {
        if (!createIfEmpty) return null;
        if (!creating.has(sessionId)) creating.set(sessionId, create(sessionId).finally(() => creating.delete(sessionId)));
        rec = await creating.get(sessionId);
      }
      const tabs = await tabsOf(rec);
      rec.known = new Set(tabs.map((t) => t.id));
      return { availableTabs: tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url })), windowId: rec.main };
    },

    async createTab(sessionId) {
      const rec = await find(sessionId);
      if (!rec) throw new Error(NO_SESSION_MESSAGE);
      const tab = await api.tabs.create({ windowId: rec.main, url: "about:blank", active: true });
      if (rec.groupId != null) await api.tabs.group({ groupId: rec.groupId, tabIds: [tab.id] }).catch(() => {});
      return tab;
    },

    async ownedTab(sessionId, tabId) {
      const rec = await find(sessionId);
      if (!rec) throw new Error(NO_SESSION_MESSAGE);
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (tab && rec.windows.has(tab.windowId)) return tab;
      const valid = (await tabsOf(rec)).map((t) => t.id);
      throw new Error(`Tab ${tabId} is not in this session's window. Valid tab IDs: ${valid.join(", ") || "none"}`);
    },

    async activate(tab) {
      if (!tab.active) await api.tabs.update(tab.id, { active: true }).catch(() => {});
    },

    // A page in a session window that opens a tab keeps it in that window; one that opens a popup
    // gets a fresh single-tab window, which joins the session. Tabs in other windows never do.
    async adoptOpened(tab) {
      if (tab.openerTabId == null) return;
      const opener = await api.tabs.get(tab.openerTabId).catch(() => null);
      const rec = opener && recordOfWindow(opener.windowId);
      if (!rec) return;
      if (rec.windows.has(tab.windowId)) {
        if (tab.windowId === rec.main && rec.groupId != null) await api.tabs.group({ groupId: rec.groupId, tabIds: [tab.id] }).catch(() => {});
        return;
      }
      if ((await api.tabs.query({ windowId: tab.windowId })).length !== 1) return;
      rec.windows.add(tab.windowId);
      await persist(rec, tab.windowId).catch(() => {});
    },

    async sessionOfTab(tab) {
      const rec = recordOfWindow(tab.windowId);
      if (rec) return rec.id;
      const value = await api.sessions.getWindowValue(tab.windowId, KEY).catch(() => undefined);
      return value?.sessionId && (await find(value.sessionId)) ? value.sessionId : null;
    },

    async sessionTabs(sessionId) {
      const rec = await find(sessionId);
      return rec ? tabsOf(rec) : [];
    },

    async isStopped(sessionId) {
      return (await find(sessionId))?.stopped ?? false;
    },

    async setStopped(sessionId, stopped) {
      const rec = await find(sessionId);
      if (!rec) return;
      rec.stopped = stopped;
      if (!stopped) rec.status = "idle";
      for (const windowId of rec.windows) await persist(rec, windowId).catch(() => {});
      await applyLabel(rec);
    },

    async setStatus(sessionId, status) {
      const rec = records.get(sessionId);
      if (!rec || rec.status === status) return;
      rec.status = status;
      await applyLabel(rec);
    },

    async tabChanges(sessionId) {
      const rec = records.get(sessionId);
      if (!rec) return "";
      const tabs = await tabsOf(rec);
      const before = rec.known ?? new Set(tabs.map((t) => t.id));
      rec.known = new Set(tabs.map((t) => t.id));
      const opened = tabs.filter((t) => !before.has(t.id)).map((t) => `opened ${t.id} ${JSON.stringify(t.title ?? "")} ${t.url}`);
      const closed = [...before].filter((id) => !rec.known.has(id)).map((id) => `closed ${id}`);
      return opened.length || closed.length ? `Tabs changed: ${[...opened, ...closed].join("; ")}` : "";
    },

    windowRemoved(windowId) {
      for (const rec of [...records.values()]) {
        if (rec.main === windowId) records.delete(rec.id);
        else rec.windows.delete(windowId);
      }
    },

    async close(sessionId) {
      const rec = records.get(sessionId);
      records.delete(sessionId);
      if (rec) for (const windowId of rec.windows) await api.sessions.removeWindowValue(windowId, KEY).catch(() => {});
    },
  };
}
```

Replace `extension/background/dispatch.js` with:

```js
export function createDispatcher({ tools, sessions, activity, send }) {
  const tabQueues = new Map();

  function enqueue(tabId, fn) {
    const previous = tabQueues.get(tabId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => {});
    tabQueues.set(tabId, settled);
    settled.then(() => { if (tabQueues.get(tabId) === settled) tabQueues.delete(tabId); });
    return run;
  }

  async function execute({ sessionId, tool, args = {} }) {
    const def = tools[tool];
    if (!def) throw new Error(`Unknown tool: ${tool}`);
    if (!def.tabScoped) return def.run({ sessionId, args });
    const tabId = typeof args.tabId === "string" && /^\d+$/.test(args.tabId) ? Number(args.tabId) : args.tabId;
    if (!Number.isInteger(tabId)) throw new Error(`${tool}: tabId must be an integer`);
    return enqueue(tabId, async () => {
      const tab = await sessions.ownedTab(sessionId, tabId);
      await sessions.activate(tab);
      activity.start(tab.id);
      try {
        return await def.run({ sessionId, args: { ...args, tabId }, tab });
      } finally {
        activity.end(tab.id);
      }
    });
  }

  async function notes({ sessionId, tool }) {
    if (tool === "tabs_context") return [];
    const changes = await sessions.tabChanges(sessionId).catch(() => "");
    return changes ? [{ type: "text", text: changes }] : [];
  }

  return async function dispatch(msg) {
    if (msg.type === "session_closed") {
      await sessions.close(msg.sessionId);
      return;
    }
    if (msg.type !== "call") return;
    let reply;
    try {
      reply = { content: toContent(await execute(msg)), isError: false };
    } catch (err) {
      reply = { content: [{ type: "text", text: err?.message || String(err) }], isError: true };
    }
    reply.content.push(...(await notes(msg)));
    send({ type: "result", id: msg.id, ...reply });
  };
}

function toContent(value) {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (Array.isArray(value)) return [...value];
  throw new Error("Tool returned an unsupported result");
}
```

In `extension/background/tools/tabs.js` change the `tabs_context` fallback to `"This session has no window yet. Call tabs_context with createIfEmpty: true to create one."`.

In `extension/background/tools/computer.js` delete the line `await api.tabs.group({ groupId: tab.groupId, tabIds: [opened.id] });` (the background's `tabs.onCreated` listener adopts the tab through `adoptOpened`).

In `extension/background/main.js` add after the `tabs.onCreated` listener:

```js
api.windows.onRemoved.addListener((windowId) => sessions.windowRemoved(windowId));
```

In `extension/manifest.json` change `permissions` to `["nativeMessaging", "tabs", "tabGroups", "sessions", "<all_urls>", "webRequest", "webNavigation", "clipboardWrite"]`.

In `host/src/tools.js`:
- `tabId` description: `"ID of a tab in this session's Firefox window (see tabs_context)."`;
- `tabs_context` description: `"List the tabs in this session's Firefox window. Call this first in every conversation to learn which tab IDs you may use. Each Claude Code session gets its own window, and tabs outside it cannot be controlled. Pass createIfEmpty: true to open the window (with one blank tab) when this session has none yet. Later results end with a \"Tabs changed\" line when tabs open or close in the window."`;
- `createIfEmpty` description: `"Open the session's window with a blank tab if this session has none yet."`;
- `tabs_create` description: `"Open a new blank tab in this session's window and return its tab ID."`;
- `tabs_close` description: `"Close a tab in this session's window."`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/background/sessions.js extension/background/dispatch.js extension/background/tools/tabs.js extension/background/tools/computer.js extension/background/main.js extension/manifest.json host/src/tools.js test/unit/sessions.test.js test/unit/dispatch.test.js test/unit/computer.test.js
git commit -m "Give each session its own window and remember it across reloads"
```

---

### Task 7: Stop and Resume

**Files:**
- Create: `extension/background/control.js`, `extension/background/presence.js`
- Modify: `extension/background/dispatch.js` (run calls through `control`, pass `signal`)
- Modify: `extension/background/main.js` (wire control, presence and the pill's messages)
- Rewrite: `extension/content/indicator.js` (pill, own palette, replaces a stale host)
- Modify: `extension/content/input.js` (hit-testing skips the indicator)
- Test: `test/unit/control.test.js` (new), `test/unit/presence.test.js` (new), `test/unit/indicator.test.js` (new), `test/unit/dispatch.test.js`, `test/unit/input-pointer.test.js`

**Interfaces:**
- Consumes: `sessions.isStopped`, `setStopped`, `setStatus`, `sessionOfTab`, `sessionTabs` (Task 6).
- Produces: `STOPPED_MESSAGE`; `createControl({ sessions, onChange, idleAfterMs = 20_000 })` → `{ run(sessionId, fn(signal)), stop(sessionId), resume(sessionId) }`. `createPresence({ api, content, sessions })` → `{ refreshTab(tab), refreshSession(sessionId), install() }`. Content op `indicator.session({ state: "active" | "stopped" | null })`. Pill message `{ type: "control", action: "stop" | "resume" }`. Dispatcher signature `createDispatcher({ tools, sessions, activity, control, send })`; tools receive `signal`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/control.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { STOPPED_MESSAGE, createControl } from "../../extension/background/control.js";

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
```

Create `test/unit/presence.test.js`:

```js
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
```

Create `test/unit/indicator.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./helpers/dom.js";

function setup() {
  const w = loadContent("<p>Page</p>", ["indicator.js"]);
  // jsdom has neither matchMedia nor Element.animate; reduced motion skips the animation.
  w.matchMedia = () => ({ matches: true });
  const sent = [];
  w.browser = { runtime: { sendMessage: (message) => { sent.push(message); return Promise.resolve(); } } };
  const roots = [];
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function attachShadow(init) {
    const root = attach.call(this, { ...init, mode: "open" });
    roots.push(root);
    return root;
  };
  return { w, sent, roots, indicator: w.__cf.indicator };
}

test("the session pill offers Stop while active and Resume while stopped", () => {
  const { w, roots, indicator } = setup();
  indicator.session({ state: "active" });
  const host = w.document.querySelector("claude-firefox-indicator");
  assert.equal(host.style.display, "block");
  assert.match(roots[0].textContent, /Claude is using this window/);
  assert.equal(roots[0].querySelector("button").textContent, "Stop");
  indicator.session({ state: "stopped" });
  assert.match(roots[0].textContent, /Stopped/);
  assert.equal(roots[0].querySelector("button").textContent, "Resume");
  indicator.session({ state: null });
  assert.equal(host.style.display, "none");
});

test("script-generated clicks on the pill are ignored", () => {
  const { roots, sent, indicator } = setup();
  indicator.session({ state: "active" });
  roots[0].querySelector("button").click();
  assert.deepEqual(sent, []);
});

test("screenshots hide the pill and a host left by an earlier injection is replaced", () => {
  const { w, indicator } = setup();
  const stale = w.document.createElement("claude-firefox-indicator");
  w.document.documentElement.append(stale);
  indicator.session({ state: "active" });
  const hosts = w.document.querySelectorAll("claude-firefox-indicator");
  assert.equal(hosts.length, 1);
  assert.notEqual(hosts[0], stale);
  indicator.suspend();
  assert.equal(hosts[0].style.display, "none");
  indicator.resume();
  assert.equal(hosts[0].style.display, "block");
});
```

Append to `test/unit/input-pointer.test.js`:

```js
test("synthetic clicks look through the indicator's Stop pill to the page beneath", () => {
  const w = setup(`<button id="b">Beneath</button>`);
  const host = w.document.createElement("claude-firefox-indicator");
  w.document.documentElement.append(host);
  const button = w.document.getElementById("b");
  stubElementFromPoint(w, () => host);
  w.Document.prototype.elementsFromPoint = function elementsFromPoint() { return [host, button, this.body]; };
  const seen = recorder(button);
  w.__cf.input.click({ x: 50, y: 20 });
  assert.ok(seen.includes("click"));
});
```

In `test/unit/dispatch.test.js`:
- add imports `import { STOPPED_MESSAGE, createControl } from "../../extension/background/control.js";`;
- in `setup`, pass a pass-through control: `createDispatcher({ tools, sessions, activity, control: { run: (_id, fn) => fn(new AbortController().signal) }, send: (m) => sent.push(m) })`;
- in the test "tab-scoped tools receive the owned tab and drive the indicator", also assert `assert.equal(seen.signal.aborted, false);`;
- append:

```js
test("Stop rejects the running and queued calls of the session with one result each", async () => {
  const stopped = new Set();
  const sessions = {
    ownedTab: async (_s, tabId) => ({ id: tabId, active: true }),
    activate: async () => {},
    tabChanges: async () => "",
    close: async () => {},
    isStopped: async (id) => stopped.has(id),
    setStopped: async (id, value) => { if (value) stopped.add(id); else stopped.delete(id); },
    setStatus: async () => {},
  };
  const control = createControl({ sessions, idleAfterMs: 5 });
  const ran = [];
  const tools = { slow: { tabScoped: true, run: ({ args }) => { ran.push(args.n); return new Promise(() => {}); } } };
  const sent = [];
  const dispatch = createDispatcher({ tools, sessions, activity: { start() {}, end() {} }, control, send: (m) => sent.push(m) });
  const first = dispatch(call("slow", { tabId: 1, n: 1 }, "1:1"));
  const second = dispatch(call("slow", { tabId: 1, n: 2 }, "1:2"));
  await new Promise((resolve) => setImmediate(resolve));
  await control.stop("s");
  await Promise.all([first, second]);
  assert.deepEqual(sent.map((m) => [m.id, m.isError, m.content[0].text]), [["1:1", true, STOPPED_MESSAGE], ["1:2", true, STOPPED_MESSAGE]]);
  assert.deepEqual(ran, [1]);
  const later = await dispatch(call("slow", { tabId: 1, n: 3 }, "1:3")).then(() => sent.at(-1));
  assert.equal(later.content[0].text, STOPPED_MESSAGE);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `control.js`, `presence.js` and `indicator.session` do not exist; the pill-hit test clicks the host.

- [ ] **Step 3: Implement**

Create `extension/background/control.js`:

```js
export const STOPPED_MESSAGE = "The user pressed Stop in Firefox. Stop using the browser and ask the user how to continue. Browser calls fail until they press Resume.";
export const IDLE_AFTER_MS = 20_000;

export function createControl({ sessions, onChange = async () => {}, idleAfterMs = IDLE_AFTER_MS }) {
  const controllers = new Map();
  const running = new Map();
  const idleTimers = new Map();

  function controllerOf(sessionId) {
    let controller = controllers.get(sessionId);
    if (!controller) controllers.set(sessionId, (controller = new AbortController()));
    return controller;
  }

  function begin(sessionId) {
    running.set(sessionId, (running.get(sessionId) ?? 0) + 1);
    clearTimeout(idleTimers.get(sessionId));
    idleTimers.delete(sessionId);
    sessions.setStatus(sessionId, "busy").catch(() => {});
  }

  function end(sessionId) {
    const left = (running.get(sessionId) ?? 1) - 1;
    if (left > 0) {
      running.set(sessionId, left);
      return;
    }
    running.delete(sessionId);
    idleTimers.set(sessionId, setTimeout(() => {
      idleTimers.delete(sessionId);
      sessions.setStatus(sessionId, "idle").catch(() => {});
    }, idleAfterMs));
  }

  return {
    // The call's own work may continue after Stop, but its result is never delivered.
    async run(sessionId, fn) {
      if (await sessions.isStopped(sessionId)) throw new Error(STOPPED_MESSAGE);
      const { signal } = controllerOf(sessionId);
      begin(sessionId);
      try {
        return await new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error(STOPPED_MESSAGE));
          signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve()
            .then(() => fn(signal))
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
        });
      } finally {
        end(sessionId);
      }
    },

    async stop(sessionId) {
      await sessions.setStopped(sessionId, true);
      controllers.get(sessionId)?.abort();
      controllers.delete(sessionId);
      await onChange(sessionId);
    },

    async resume(sessionId) {
      await sessions.setStopped(sessionId, false);
      await onChange(sessionId);
    },
  };
}
```

Create `extension/background/presence.js`:

```js
export function createPresence({ api, content, sessions }) {
  const marked = new Set();

  async function stateOf(tab) {
    const sessionId = await sessions.sessionOfTab(tab);
    if (!sessionId) return null;
    return (await sessions.isStopped(sessionId)) ? "stopped" : "active";
  }

  // Tabs outside sessions are only messaged when they need clearing, so ordinary browsing costs nothing.
  async function refreshTab(tab) {
    const state = await stateOf(tab);
    if (!state && !marked.has(tab.id)) return;
    if (state) marked.add(tab.id);
    else marked.delete(tab.id);
    await content.call(tab.id, 0, "indicator.session", { state }).catch(() => {});
  }

  return {
    refreshTab,
    async refreshSession(sessionId) {
      for (const tab of await sessions.sessionTabs(sessionId)) await refreshTab(tab);
    },
    install() {
      api.tabs.onUpdated.addListener((tabId, info, tab) => {
        if (info.status === "complete") refreshTab(tab).catch(() => {});
      });
      api.tabs.onAttached.addListener((tabId) => {
        api.tabs.get(tabId).then(refreshTab).catch(() => {});
      });
      api.tabs.onRemoved.addListener((tabId) => marked.delete(tabId));
    },
  };
}
```

Change `extension/background/dispatch.js`:
- add `import { STOPPED_MESSAGE } from "./control.js";` at the top;
- change the signature to `export function createDispatcher({ tools, sessions, activity, control, send }) {`;
- replace `execute` with:

```js
  async function execute({ sessionId, tool, args = {} }) {
    const def = tools[tool];
    if (!def) throw new Error(`Unknown tool: ${tool}`);
    return control.run(sessionId, (signal) => {
      if (!def.tabScoped) return def.run({ sessionId, args, signal });
      const tabId = typeof args.tabId === "string" && /^\d+$/.test(args.tabId) ? Number(args.tabId) : args.tabId;
      if (!Number.isInteger(tabId)) throw new Error(`${tool}: tabId must be an integer`);
      return enqueue(tabId, async () => {
        if (signal.aborted) throw new Error(STOPPED_MESSAGE);
        const tab = await sessions.ownedTab(sessionId, tabId);
        await sessions.activate(tab);
        activity.start(tab.id);
        try {
          return await def.run({ sessionId, args: { ...args, tabId }, tab, signal });
        } finally {
          activity.end(tab.id);
        }
      });
    });
  }
```

Change `extension/background/main.js` to:

```js
import { createActivity } from "./activity.js";
import { createCapture } from "./capture.js";
import { createContent } from "./content.js";
import { createControl } from "./control.js";
import { createDispatcher } from "./dispatch.js";
import { createLogStore, installLogListeners } from "./logs.js";
import { connectNative } from "./native.js";
import { createPresence } from "./presence.js";
import { createSessions } from "./sessions.js";
import { logTools } from "./tools/logs.js";
import { pageTools } from "./tools/page.js";
import { computerTool } from "./tools/computer.js";
import { tabTools } from "./tools/tabs.js";

const api = browser;
const content = createContent(api);
const sessions = createSessions(api);
const activity = createActivity({ api, content });
const capture = createCapture({ api, content });
const presence = createPresence({ api, content, sessions });
const control = createControl({ sessions, onChange: (sessionId) => presence.refreshSession(sessionId) });
const store = createLogStore();
installLogListeners(api, store);
presence.install();

api.tabs.onCreated.addListener((tab) => {
  sessions.adoptOpened(tab).catch(() => {});
});
api.windows.onRemoved.addListener((windowId) => sessions.windowRemoved(windowId));
api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "control" || !sender.tab) return undefined;
  sessions.sessionOfTab(sender.tab).then((sessionId) => {
    if (!sessionId) return undefined;
    return msg.action === "resume" ? control.resume(sessionId) : control.stop(sessionId);
  }).catch(() => {});
  return undefined;
});

const tools = {
  ...tabTools({ api, sessions }),
  ...pageTools({ api, content }),
  ...computerTool({ api, content, capture }),
  ...logTools({ store }),
};

let native = null;
const dispatch = createDispatcher({ tools, sessions, activity, control, send: (msg) => native.send(msg) });
native = connectNative({ api, name: "claude_firefox_bridge", onMessage: dispatch });
```

Replace `extension/content/indicator.js` with:

```js
(() => {
  if (window !== window.top || globalThis.__cf?.indicator) return;
  const cf = (globalThis.__cf ??= {});
  const SVG = "http://www.w3.org/2000/svg";
  const ACCENT = "124, 92, 255";
  const PILL = { active: ["Claude is using this window", "Stop"], stopped: ["Stopped", "Resume"] };
  let host = null;
  let glow = null;
  let cursor = null;
  let pill = null;
  let pillLabel = null;
  let pillButton = null;
  let hideTimer = null;
  let visible = false;
  let suspended = false;
  let session = null;

  function build() {
    // A host left by an injection from before an add-on reload no longer has a working button.
    for (const stale of document.querySelectorAll("claude-firefox-indicator")) stale.remove();
    host = document.createElement("claude-firefox-indicator");
    host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; display: none;";
    const root = host.attachShadow({ mode: "closed" });
    glow = document.createElement("div");
    glow.style.cssText = `position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(${ACCENT}, .9), inset 0 0 28px rgba(${ACCENT}, .45);`;
    cursor = document.createElementNS(SVG, "svg");
    cursor.setAttribute("width", "22");
    cursor.setAttribute("height", "22");
    cursor.setAttribute("viewBox", "0 0 24 24");
    cursor.style.cssText = `position: fixed; left: 0; top: 0; transform: translate(-100px, -100px); transition: transform 180ms ease-out; filter: drop-shadow(0 0 3px rgba(${ACCENT}, .8));`;
    const arrow = document.createElementNS(SVG, "path");
    arrow.setAttribute("d", "M3 2 L3 19 L7.5 14.5 L10.5 21 L13 20 L10 13.5 L16.5 13.5 Z");
    arrow.setAttribute("fill", "#FFFFFF");
    arrow.setAttribute("stroke", `rgb(${ACCENT})`);
    arrow.setAttribute("stroke-width", "1.5");
    arrow.setAttribute("stroke-linejoin", "round");
    cursor.append(arrow);
    pill = document.createElement("div");
    pill.style.cssText = "position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: none; align-items: center; gap: 10px; padding: 6px 6px 6px 14px; border-radius: 999px; background: rgba(24, 20, 38, .92); color: #fff; font: 13px/1.2 system-ui, sans-serif; box-shadow: 0 2px 12px rgba(0, 0, 0, .3); pointer-events: auto;";
    pillLabel = document.createElement("span");
    pillButton = document.createElement("button");
    pillButton.type = "button";
    pillButton.style.cssText = `all: unset; cursor: pointer; padding: 4px 12px; border-radius: 999px; background: rgb(${ACCENT}); color: #fff; font: 600 13px/1.2 system-ui, sans-serif;`;
    // Only the user can press this: Claude's input is synthetic and never trusted.
    pillButton.addEventListener("click", (event) => {
      if (!event.isTrusted || !session) return;
      browser.runtime.sendMessage({ type: "control", action: session === "stopped" ? "resume" : "stop" }).catch(() => {});
    });
    pill.append(pillLabel, pillButton);
    root.append(glow, cursor, pill);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      glow.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 1000, direction: "alternate", iterations: Infinity });
    }
  }

  function render() {
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    glow.style.display = visible ? "block" : "none";
    cursor.style.display = visible ? "block" : "none";
    pill.style.display = session ? "flex" : "none";
    if (session) [pillLabel.textContent, pillButton.textContent] = PILL[session];
    host.style.display = (visible || session) && !suspended ? "block" : "none";
  }

  cf.indicator = {
    show() {
      clearTimeout(hideTimer);
      visible = true;
      render();
    },
    hideSoon() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        visible = false;
        render();
      }, 2000);
    },
    suspend() {
      suspended = true;
      if (host) render();
    },
    resume() {
      suspended = false;
      if (host) render();
    },
    session({ state }) {
      session = state === "active" || state === "stopped" ? state : null;
      render();
      return {};
    },
    moveCursor({ x, y }) {
      if (!host) build();
      cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    },
  };
})();
```

In `extension/content/input.js` add before `function locate`:

```js
  // The indicator's Stop pill takes real clicks only; synthetic input looks through it to the page.
  function pointTarget(doc, x, y) {
    const el = doc.elementFromPoint(x, y);
    if (el?.tagName !== "CLAUDE-FIREFOX-INDICATOR") return el;
    return doc.elementsFromPoint(x, y).find((candidate) => candidate.tagName !== "CLAUDE-FIREFOX-INDICATOR") ?? null;
  }
```

and replace `doc.elementFromPoint(lx, ly)` in `locate` with `pointTarget(doc, lx, ly)`, and `doc.elementFromPoint(x, y) ?? over` in `drag` with `pointTarget(doc, x, y) ?? over`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/background/control.js extension/background/presence.js extension/background/dispatch.js extension/background/main.js extension/content/indicator.js extension/content/input.js test/unit/control.test.js test/unit/presence.test.js test/unit/indicator.test.js test/unit/dispatch.test.js test/unit/input-pointer.test.js
git commit -m "Add a Stop and Resume control that only the user can press"
```

---

### Task 8: Answer page dialogs in session tabs

**Files:**
- Create: `extension/content/dialogs.js`, `extension/background/dialogs.js`
- Modify: `extension/background/presence.js` (broadcast `dialogs.enable`, answer `dialogsEnabled`)
- Modify: `extension/background/dispatch.js` (append dialog reports after a tab-scoped call)
- Modify: `extension/background/main.js` (dialog messages)
- Modify: `extension/manifest.json` (content script list)
- Modify: `host/src/tools.js` (`computer` description)
- Modify: `test/unit/helpers/dom.js` (`before` hook)
- Test: `test/unit/dialogs-content.test.js` (new), `test/unit/dialogs.test.js` (new), `test/unit/presence.test.js`, `test/unit/dispatch.test.js`

**Interfaces:**
- Consumes: `presence` (Task 7), `sessions.sessionOfTab`, `isStopped`.
- Produces: content op `dialogs.enable({ on })`; messages `{ type: "dialogs.query" }` → `{ on }` and `{ type: "dialog", kind, message, answer }`. `createDialogLog()` → `{ add(tabId, report), take(tabId) → string[], removeTab(tabId) }`; `formatDialog(report)`. `createDispatcher({ tools, sessions, activity, control, dialogs, send })`. `presence.dialogsEnabled(tab)` → boolean.

- [ ] **Step 1: Write the failing tests**

In `test/unit/helpers/dom.js` change `loadContent` to accept a `before` hook that runs before the scripts are evaluated:

```js
export function loadContent(html, files = ["tree.js"], { url = "https://example.test/page", before } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Test</title></head><body>${html}</body></html>`, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.PointerEvent ??= w.MouseEvent;
  w.Element.prototype.scrollIntoView = function scrollIntoView() {};
  w.Element.prototype.checkVisibility = function checkVisibility() { return true; };
  w.Document.prototype.execCommand = function execCommand() { return false; };
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
  before?.(w);
  for (const file of files) w.eval(readFileSync(new URL(file, CONTENT), "utf8"));
  return w;
}
```

Create `test/unit/dialogs-content.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./helpers/dom.js";

function setup({ on = false } = {}) {
  const sent = [];
  const shown = [];
  const w = loadContent("", ["dialogs.js"], {
    before(w) {
      w.alert = (...args) => { shown.push(["alert", ...args]); };
      w.confirm = (...args) => { shown.push(["confirm", ...args]); return false; };
      w.prompt = (...args) => { shown.push(["prompt", ...args]); return null; };
      w.wrappedJSObject = w;
      w.exportFunction = (fn, target, { defineAs }) => { target[defineAs] = fn; return fn; };
      w.browser = { runtime: { sendMessage: (message) => { sent.push(message); return Promise.resolve(message.type === "dialogs.query" ? { on } : undefined); } } };
    },
  });
  return { w, sent, shown };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("outside a session the page's own dialogs run", async () => {
  const { w, shown, sent } = setup();
  await tick();
  assert.equal(w.confirm("Sure?"), false);
  w.alert();
  assert.deepEqual(shown, [["confirm", "Sure?"], ["alert"]]);
  assert.deepEqual(sent.map((m) => m.type), ["dialogs.query"]);
});

test("in a session tab dialogs are answered and reported without showing", async () => {
  const { w, shown, sent } = setup({ on: true });
  await tick();
  assert.equal(w.confirm("Delete this item?"), true);
  assert.equal(w.prompt("Name?", "Ada"), "Ada");
  assert.equal(w.prompt("Age?"), "");
  assert.equal(w.alert("Saved"), undefined);
  assert.deepEqual(shown, []);
  const reports = sent.filter((m) => m.type === "dialog").map(({ kind, message, answer }) => [kind, message, answer]);
  assert.deepEqual(reports, [["confirm", "Delete this item?", true], ["prompt", "Name?", "Ada"], ["prompt", "Age?", ""], ["alert", "Saved", null]]);
});

test("the background switches auto-answering on and off", () => {
  const { w, shown } = setup();
  w.__cf.dialogs.enable({ on: true });
  w.confirm("x");
  w.__cf.dialogs.enable({ on: false });
  w.confirm("y");
  assert.deepEqual(shown, [["confirm", "y"]]);
});

test("in a session tab the page's beforeunload handlers never run", () => {
  const { w } = setup();
  let ran = 0;
  w.addEventListener("beforeunload", () => { ran++; });
  w.__cf.dialogs.enable({ on: true });
  w.dispatchEvent(new w.Event("beforeunload"));
  w.__cf.dialogs.enable({ on: false });
  w.dispatchEvent(new w.Event("beforeunload"));
  assert.equal(ran, 1);
});
```

Create `test/unit/dialogs.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createDialogLog, formatDialog } from "../../extension/background/dialogs.js";

test("dialog reports read as the answer that was given", () => {
  assert.equal(formatDialog({ kind: "confirm", message: "Delete this item?", answer: true }), 'Dialog: confirm("Delete this item?") → OK');
  assert.equal(formatDialog({ kind: "alert", message: "Saved", answer: null }), 'Dialog: alert("Saved") → dismissed');
  assert.equal(formatDialog({ kind: "prompt", message: "Name?", answer: "Ada" }), 'Dialog: prompt("Name?") → "Ada"');
});

test("reports are taken once per tab, capped, and dropped with the tab", () => {
  const log = createDialogLog();
  for (let i = 0; i < 25; i++) log.add(1, { kind: "alert", message: `m${i}`, answer: null });
  log.add(2, { kind: "confirm", message: "x", answer: true });
  log.add(2, { kind: "bogus", message: "y" });
  const taken = log.take(1);
  assert.equal(taken.length, 20);
  assert.equal(taken[0], 'Dialog: alert("m5") → dismissed');
  assert.deepEqual(log.take(1), []);
  log.removeTab(2);
  assert.deepEqual(log.take(2), []);
});
```

In `test/unit/presence.test.js`:
- give the fake `api` a `tabs.sendMessage` that records `["broadcast", tabId, message.args.on]` into `calls`: replace `api: {}` with `api: { tabs: { sendMessage: async (tabId, message) => { calls.push([tabId, "dialogs.enable", message.args.on]); } } }`;
- update the expected arrays: the first test becomes `[[1, "indicator.session", "active"], [1, "dialogs.enable", true]]`; the second test's first expectation becomes `[[1, "indicator.session", "stopped"], [1, "dialogs.enable", false], [2, "indicator.session", "stopped"], [2, "dialogs.enable", false]]` and the cleared-tab expectation becomes `calls.slice(4)` equal to `[[2, "indicator.session", null], [2, "dialogs.enable", false]]`;
- append:

```js
test("dialog auto-answering is on only for tabs of a running session", async () => {
  const { presence, stopped } = setup();
  assert.equal(await presence.dialogsEnabled({ id: 1 }), true);
  assert.equal(await presence.dialogsEnabled({ id: 9 }), false);
  stopped.add("s");
  assert.equal(await presence.dialogsEnabled({ id: 1 }), false);
});
```

In `test/unit/dispatch.test.js`:
- in `setup` add `const dialogs = { take: (tabId) => (tabId === 5 ? ['Dialog: alert("Hi") → dismissed'] : []) };` and pass `dialogs` to `createDispatcher`; in the Task 7 stop test pass `dialogs: { take: () => [] }`;
- append:

```js
test("dialog reports are added only to calls that own the tab", async () => {
  const tools = { look: { tabScoped: true, run: async () => "ok" } };
  const { dispatch, sent } = setup(tools);
  await dispatch(call("look", { tabId: 5 }));
  assert.deepEqual(sent[0].content.map((b) => b.text), ["ok", 'Dialog: alert("Hi") → dismissed']);
  const denied = setup(tools, async () => { throw new Error("Tab 5 is not in this session's window. Valid tab IDs: 1"); });
  await denied.dispatch(call("look", { tabId: 5 }));
  assert.deepEqual(denied.sent[0].content.map((b) => b.text), ["Tab 5 is not in this session's window. Valid tab IDs: 1"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `dialogs.js` files do not exist; presence does not broadcast.

- [ ] **Step 3: Implement**

Create `extension/content/dialogs.js`:

```js
(() => {
  if (globalThis.__cf?.dialogs) return;
  const cf = (globalThis.__cf ??= {});
  const MAX_MESSAGE = 500;
  let enabled = false;

  const text = (value) => {
    try {
      return String(value ?? "").slice(0, MAX_MESSAGE);
    } catch {
      return "";
    }
  };
  const report = (kind, message, answer) => {
    browser.runtime.sendMessage({ type: "dialog", kind, message: text(message), answer }).catch(() => {});
  };

  cf.dialogs = {
    enable({ on }) {
      enabled = on === true;
      return {};
    },
  };

  // Registered before any page script, so stopping propagation here keeps page handlers from asking "Leave page?".
  window.addEventListener("beforeunload", (event) => { if (enabled) event.stopImmediatePropagation(); }, true);

  browser.runtime.sendMessage({ type: "dialogs.query" }).then((reply) => {
    if (typeof reply?.on === "boolean") enabled = reply.on;
  }, () => {});

  const page = window.wrappedJSObject;
  if (!page) return;
  // As in console-hook.js, the page's functions are kept on the window for later injections to find.
  if (!page.__claudeFirefoxDialogOriginals) {
    const kept = new page.Object();
    for (const name of ["alert", "confirm", "prompt"]) kept[name] = page[name];
    const descriptor = new page.Object();
    descriptor.value = kept;
    descriptor.configurable = true;
    page.Object.defineProperty(page, "__claudeFirefoxDialogOriginals", descriptor);
  }
  const originals = page.__claudeFirefoxDialogOriginals;

  exportFunction(function alert(...args) {
    if (!enabled) return originals.alert.call(this, ...args);
    report("alert", args[0], null);
    return undefined;
  }, page, { defineAs: "alert" });
  exportFunction(function confirm(...args) {
    if (!enabled) return originals.confirm.call(this, ...args);
    report("confirm", args[0], true);
    return true;
  }, page, { defineAs: "confirm" });
  exportFunction(function prompt(...args) {
    if (!enabled) return originals.prompt.call(this, ...args);
    const answer = args[1] === undefined ? "" : text(args[1]);
    report("prompt", args[0], answer);
    return answer;
  }, page, { defineAs: "prompt" });
})();
```

Create `extension/background/dialogs.js`:

```js
const KINDS = new Set(["alert", "confirm", "prompt"]);
const MAX_PER_TAB = 20;

export function formatDialog({ kind, message, answer }) {
  const given = kind === "alert" ? "dismissed" : kind === "confirm" ? (answer ? "OK" : "Cancel") : JSON.stringify(answer);
  return `Dialog: ${kind}(${JSON.stringify(message)}) → ${given}`;
}

export function createDialogLog() {
  const byTab = new Map();
  return {
    add(tabId, { kind, message, answer }) {
      if (!KINDS.has(kind)) return;
      const list = byTab.get(tabId) ?? [];
      list.push({ kind, message: String(message ?? ""), answer });
      if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB);
      byTab.set(tabId, list);
    },
    take(tabId) {
      const list = byTab.get(tabId) ?? [];
      byTab.delete(tabId);
      return list.map(formatDialog);
    },
    removeTab(tabId) {
      byTab.delete(tabId);
    },
  };
}
```

In `extension/background/presence.js`:
- in `refreshTab`, after the `content.call(...)` line add:

```js
    await api.tabs.sendMessage(tab.id, { op: "dialogs.enable", args: { on: state === "active" } }).catch(() => {});
```

- add to the returned object:

```js
    async dialogsEnabled(tab) {
      return (await stateOf(tab)) === "active";
    },
```

In `extension/background/dispatch.js`:
- change the signature to `export function createDispatcher({ tools, sessions, activity, control, dialogs, send }) {`;
- in `execute`, replace the `try { return await def.run(...) } finally {...}` block with:

```js
        try {
          const content = toContent(await def.run({ sessionId, args: { ...args, tabId }, tab, signal }));
          return [...content, ...dialogs.take(tab.id).map((text) => ({ type: "text", text }))];
        } finally {
          activity.end(tab.id);
        }
```

In `extension/background/main.js`:
- add `import { createDialogLog } from "./dialogs.js";`, create `const dialogs = createDialogLog();` after `store`, pass `dialogs` to `createDispatcher`, and add `api.tabs.onRemoved.addListener((tabId) => dialogs.removeTab(tabId));`;
- replace the `runtime.onMessage` listener with:

```js
api.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return undefined;
  if (msg?.type === "dialog") dialogs.add(sender.tab.id, msg);
  if (msg?.type === "dialogs.query") return presence.dialogsEnabled(sender.tab).then((on) => ({ on }));
  if (msg?.type === "control") {
    sessions.sessionOfTab(sender.tab).then((sessionId) => {
      if (!sessionId) return undefined;
      return msg.action === "resume" ? control.resume(sessionId) : control.stop(sessionId);
    }).catch(() => {});
  }
  return undefined;
});
```

In `extension/manifest.json` change the first content script's `js` list to `["content/console-hook.js", "content/dialogs.js", "content/dom.js", "content/tree.js", "content/form.js", "content/text.js", "content/input.js", "content/router.js"]`.

In `host/src/tools.js` add one bullet to the `computer` description after the navigation bullet from Task 5:

```js
      "* In this session's tabs, alert() is dismissed, confirm() answers OK and prompt() returns its default text; the result shows each dialog and the answer given.",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/content/dialogs.js extension/background/dialogs.js extension/background/presence.js extension/background/dispatch.js extension/background/main.js extension/manifest.json host/src/tools.js test/unit/helpers/dom.js test/unit/dialogs-content.test.js test/unit/dialogs.test.js test/unit/presence.test.js test/unit/dispatch.test.js
git commit -m "Answer page dialogs in session tabs and report them to Claude"
```

---

### Task 9: End-to-end coverage, README and version 0.2.0

**Files:**
- Create: `test/e2e/pages/session.html`
- Modify: `test/e2e/pages/tree.html`, `test/e2e/pages/forms.html`
- Modify: `test/e2e/e2e.test.js`
- Modify: `README.md`
- Modify: `extension/manifest.json`, `package.json`, `package-lock.json` (version), `host/src/mcp-server.js` (server version)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add fixture content**

Create `test/e2e/pages/session.html`:

```html
<!doctype html><title>Session page</title>
<script>
  const log = (text) => console.log(text);
  log("visibility " + document.visibilityState);
  document.addEventListener("visibilitychange", () => log("visibility " + document.visibilityState));
  window.addEventListener("beforeunload", () => log("page beforeunload ran"));
</script>
<p><button id="confirm" onclick="log('confirm returned ' + confirm('Delete this item?'))">Confirm</button></p>
<p><button id="prompt" onclick="log('prompt returned ' + prompt('Name?', 'Ada'))">Prompt</button></p>
<p><button id="unload" onclick="window.dispatchEvent(new Event('beforeunload')); log('fired beforeunload')">Fire beforeunload</button></p>
<form action="/basic.html"><button id="go">Go to basic</button></form>
<p><button id="push" onclick="history.pushState(null, '', '?pushed')">Push state</button></p>
<button id="bottom" style="position: fixed; left: 0; right: 0; bottom: 0; height: 120px" onclick="log('bottom clicked')">Bottom bar</button>
```

Append inside `<body>` of `test/e2e/pages/tree.html`:

```html
<button aria-expanded="false">Menu</button>
<div role="tab" aria-selected="true">Overview</div>
<button aria-pressed="true">Bold</button>
<details><summary>More options</summary><p>Hidden option text</p></details>
```

Append inside `<body>` of `test/e2e/pages/forms.html`:

```html
<div role="group" aria-label="Nickname field"><span>Nickname</span><input id="nickname" oninput="log('nickname ' + this.value)"></div>
```

(If `forms.html` has no `log` helper, use `oninput="document.title = 'nickname ' + this.value"` and assert on the title through `tabs_context` instead.)

- [ ] **Step 2: Update and extend `test/e2e/e2e.test.js`**

Update expectations that earlier tasks changed:
- `tabs_context with createIfEmpty` test: rename to `"tabs_context with createIfEmpty opens a window holding one tab"` and assert `assert.ok(Number.isInteger(ctx.windowId));` instead of `tabGroupId`;
- `"another session cannot touch this session's tabs"`: `/no window yet/` and `` new RegExp(`Tab ${tabId} is not in this session's window`) ``;
- `read_page` test: `href="http:\/\/127\.0\.0\.1:\d+\/basic\.html"` and `value="\(sensitive value hidden\)"`;
- `"form_input never echoes password values"`: `"Set password value to (hidden) (previous: (hidden))"`;
- `"target=_blank links open in a new tab inside the session's group"`: rename to `"... inside the session's window"`; keep its assertions on the opened tab being usable;
- any assertion on `Option "…" not found` or `Checkbox requires` uses the Task 3 messages.

Append a new `describe` block:

```js
describe("session window", () => {
  let tabId;
  const log = async () => textOf(await h.call("read_console_messages", { tabId }));

  before(async () => {
    tabId = await openTab("/session.html");
  });

  test("the session's active tab is visible even though its window is not focused", async () => {
    assert.match(await log(), /visibility visible/);
    assert.doesNotMatch(await log(), /visibility hidden/);
  });

  test("confirm and prompt are answered automatically and reported", async () => {
    const confirmed = textOf(await h.call("find", { tabId, query: "Confirm button" }));
    const ref = /- (ref_\d+):/.exec(confirmed)[1];
    const r = textOf(await h.call("computer", { tabId, action: "left_click", ref }));
    assert.match(r, /Dialog: confirm\("Delete this item\?"\) → OK/);
    assert.match(await log(), /confirm returned true/);
    const promptRef = /- (ref_\d+):/.exec(textOf(await h.call("find", { tabId, query: "Prompt button" })))[1];
    assert.match(textOf(await h.call("computer", { tabId, action: "left_click", ref: promptRef })), /Dialog: prompt\("Name\?"\) → "Ada"/);
  });

  test("page beforeunload handlers are suppressed in session tabs", async () => {
    const ref = /- (ref_\d+):/.exec(textOf(await h.call("find", { tabId, query: "Fire beforeunload button" })))[1];
    await h.call("computer", { tabId, action: "left_click", ref });
    const text = await log();
    assert.match(text, /fired beforeunload/);
    assert.doesNotMatch(text, /page beforeunload ran/);
  });

  test("Claude's click at the Stop pill's position reaches the page beneath", async () => {
    const shot = textOf(await h.call("computer", { tabId, action: "screenshot" }));
    const [, w, hgt] = /Screenshot (\d+)x(\d+)/.exec(shot).map(Number);
    await h.call("computer", { tabId, action: "left_click", coordinate: [Math.round(w / 2), hgt - 20] });
    assert.match(await log(), /bottom clicked/);
  });

  test("stringified arguments are accepted", async () => {
    const r = await h.call("computer", { tabId: String(tabId), action: "screenshot", scale: "0.5" });
    assert.equal(r.isError, false, textOf(r));
  });

  test("pushState and form submissions are reported after the click", async () => {
    const pushRef = /- (ref_\d+):/.exec(textOf(await h.call("find", { tabId, query: "Push state button" })))[1];
    assert.match(textOf(await h.call("computer", { tabId, action: "left_click", ref: pushRef })), /→ URL changed to http:\/\/127\.0\.0\.1:\d+\/session\.html\?pushed/);
    const goRef = /- (ref_\d+):/.exec(textOf(await h.call("find", { tabId, query: "Go to basic button" })))[1];
    assert.match(textOf(await h.call("computer", { tabId, action: "left_click", ref: goRef })), /→ Navigated to http:\/\/127\.0\.0\.1:\d+\/basic\.html\?? — "Basic page"/);
  });
});
```

Add to the `"reading pages"` describe block:

```js
  test("read_page shows expanded, selected and pressed states", async () => {
    const tabId = await openTab("/tree.html");
    const text = textOf(await h.call("read_page", { tabId }));
    assert.match(text, /button "Menu" \[ref_\d+\] \(collapsed\)/);
    assert.match(text, /tab "Overview" \[ref_\d+\] \(selected\)/);
    assert.match(text, /button "Bold" \[ref_\d+\] \(pressed\)/);
    assert.match(text, /button "More options" \[ref_\d+\] \(collapsed\)/);
  });
```

Add to the forms describe block (use its existing `tabId`/`tree`/`refFor` helpers; `refFor(tree, "group", "Nickname field")` if the helper takes a role and a name):

```js
  test("form_input on a wrapper sets the control inside it", async () => {
    const r = textOf(await h.call("form_input", { tabId, ref: refFor(tree, "group", "Nickname field"), value: "Ada" }));
    assert.match(r, /\(used the <input> inside ref_\d+\)$/);
  });
```

Add to the console describe block:

```js
  test("console errors include a stack trace", async () => {
    const tabId = await openTab("/console.html");
    const text = textOf(await h.call("read_console_messages", { tabId, pattern: "boom on load" }));
    assert.match(text, /Error: boom on load\n {4}\S+@http:\/\/127\.0\.0\.1:\d+\/console\.html:\d+:\d+/);
  });
```

If Firefox does not expose `stack` through the Xray, this assertion fails: record that in the ledger, change the assertion to `/Error: boom on load/`, and remove the stack claim from the README instead of working around the Xray.

- [ ] **Step 3: Run the e2e suite**

Pre-check: `lsof -U 2>/dev/null | grep -c claude-firefox-bridge` or let the harness report "already served". If the user's own Firefox holds the socket, stop and report; never quit the user's Firefox.

Run: `npm run e2e`
Expected: all tests pass. Investigate failures with superpowers:systematic-debugging; the spec's "Verify during implementation" list names the Firefox behaviors most likely to differ from expectations. Record each verified or disproven behavior in the ledger.

- [ ] **Step 4: Version 0.2.0 and README**

- `npm version 0.2.0 --no-git-tag-version` (updates `package.json` and `package-lock.json`).
- `extension/manifest.json` `"version": "0.2.0"`; `host/src/mcp-server.js` `new Server({ name: "claude-in-firefox", version: "0.2.0" }, …)`.
- README changes:
  - **How it works:** replace the tab-group paragraph with: `Each Claude Code session gets its own Firefox window, opened in the background without taking focus, and can only touch tabs in that window (plus popups opened from it). The window title and, when tab groups are enabled, a tab group show the session's status: ⌛ working, ✅ idle, ⏸ stopped. A violet glow and a phantom cursor show which tab Claude is working in.`
  - **Tools table:** `tabs_context`, `tabs_create`, `tabs_close` → "List, open and close tabs in this session's window"; `computer` row → "Clicks, typing, keys, scroll, hover, drag, screenshots, zoom, wait (up to 30 s); clicks, typing and keys wait for any navigation they start".
  - **Safety:** add a first bullet `**Stop button.** Every page in a session window shows a "Claude is using this window · Stop" bar. Stop cancels the running call and makes every later call fail until you press Resume. Only a real click works; Claude's synthetic input cannot press it.`; add `**Dialogs are answered automatically in session tabs.** alert() is dismissed, confirm() answers OK, prompt() returns its default text, and "Leave page?" prompts are suppressed; Claude sees each dialog and the answer. While a session is stopped, dialogs appear normally.`; change the redaction bullet's markers to `(sensitive value hidden)` and `(hidden)`.
  - **Limitations:** delete the bullets about the session-to-group mapping being forgotten and about `browser.tabs.groups.enabled`; add `A dialog raised by a page's very first scripts, before the add-on has marked the tab as a session tab, appears normally and stalls that call until it times out.` and `Updating to 0.2.0 asks for the new "sessions" permission, which stores each session's id on its window so sessions survive add-on reloads and Firefox restarts.`

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run lint && npm run e2e`
Expected: all pass.

```bash
git add test/e2e README.md extension/manifest.json package.json package-lock.json host/src/mcp-server.js
git commit -m "Cover session windows, Stop, dialogs and settling end to end; release 0.2.0"
```

Manual checks for the ledger (they cannot be automated; the controller reports them to the user as not yet verified unless the user confirms them): a real click on Stop rejects a running `computer` `wait` and on Resume lets calls through; after reloading the add-on in `about:debugging`, `tabs_context` without `createIfEmpty` still returns the same window; creating a session leaves the user's current window focused.
