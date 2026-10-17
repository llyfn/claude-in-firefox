# Session control and robustness — design

Part 1 of the improvements found by comparing this project with beto621/open-claude-in-firefox and NetVar1337/claude-for-firefox. Neither repository is licensed, so only ideas are taken, never code. Part 2 (distribution and platforms: npx package, uninstall command, Windows, other MCP clients) gets its own spec.

Breaking changes are allowed when they make the add-on better on its own. Version becomes 0.2.0.

## Goals

1. A session owns a Firefox window instead of a tab group; tab groups become an optional label.
2. Sessions survive add-on reloads and Firefox restarts.
3. The user can stop a session from the page, and only the user can resume it.
4. `alert` / `confirm` / `prompt` and "Leave page?" never freeze a session tab.
5. Actions that start a navigation wait for it.
6. Claude learns about tab changes and the session's status is visible in the tab strip.
7. Small tool improvements: lenient arguments, richer `read_page`, `form_input` on wrappers, console stack traces, hover settle, longer `wait`.
8. Strings and styles that match Anthropic's Claude in Chrome bundle are replaced with our own.

## Non-goals

Per-site permission prompts, a sidebar chat, `javascript_tool`, GIF recording, model-based `find`, and anything in part 2.

## 1. Sessions own windows

- `tabs_context` with `createIfEmpty: true` opens a new window with one blank tab, `windows.create({ url: "about:blank", focused: false })`.
- Ownership is by window. A session owns its main window plus popup windows opened from its tabs (`tabs.onCreated` with an `openerTabId` in a session window). `ownedTab` checks `tab.windowId`; the error lists the session's tab IDs: `Tab 9 is not in this session's window. Valid tab IDs: 5, 6`.
- `NO_SESSION_MESSAGE`: `This session has no window yet. Call tabs_context with createIfEmpty: true first.`
- Before a tab-scoped tool runs, the dispatcher makes the tab the active tab of its window (`tabs.update(tabId, { active: true })` when it is not). The window is Claude's, so this does not disturb the user, and the active tab of a visible window is not throttled.
- `tabs_create` opens the tab in the main window, active. Links that would open a new tab (`computer` click results with `opened`) open in the clicked tab's window.
- `tabs_context` returns `{ availableTabs: [{ tabId, title, url }], windowId }`.
- `session_closed` forgets the session in memory and removes its window values; the windows stay open.
- When the main window closes, the session is forgotten; the next `tabs_context` with `createIfEmpty` opens a new window.

### Labels and status

- Label text: `<status>Claude · <first 8 chars of sessionId>`. Status prefixes: `⌛ ` while a call ran within the last 20 s, `✅ ` after 20 s without calls, `⏸ ` while stopped, none before the first call.
- The label is applied with `windows.update(windowId, { titlePreface: "<label> — " })` always, and as the title of a tab group holding the window's tabs when `tabs.group` succeeds (tab groups enabled). Group creation failure is ignored; nothing else depends on groups.
- Labels change only when the status changes.

### Persistence

- Window values via `browser.sessions.setWindowValue(windowId, "claudeSession", { sessionId, role: "main" | "popup", stopped })`. New permission: `sessions`.
- On a lookup miss, `windows.getAll()` is scanned with `sessions.getWindowValue` before reporting no session. This recovers sessions after an add-on reload and after Firefox restores windows on restart.

### Tab change notices

- The background keeps, per session, the set of tab IDs it last reported. After every call except `tabs_context` (which reports the full list and resets the set), it compares with the session's current tabs and, when they differ, appends one text block: `Tabs changed: opened 123 "Title" <url>; closed 118`.

## 2. Stop and Resume

- `indicator.js` gets a pill, bottom center, inside its closed shadow root: `Claude is using this window · Stop`, and `Stopped · Resume` while stopped. It is shown on every top-level page of a session window, independent of the activity glow, and hidden while a screenshot is taken. Only the pill takes pointer events. Clicks are accepted only when `event.isTrusted`.
- The background tells each session tab which pill state to show: on tab load complete, on attach to a session window, when a session starts, and on stop/resume. Tabs that leave the session get `null`.
- Synthetic input skips the indicator host when hit-testing (`elementsFromPoint`), so Claude's clicks at the pill's position reach the page beneath.
- Stop (`runtime.sendMessage({ type: "control", action: "stop" })` from the pill; the session is found from `sender.tab.windowId`):
  - marks the session stopped and persists it;
  - aborts the session's `AbortController`, which rejects the running call at once and ends its waits;
  - every queued and later call fails with `STOPPED_MESSAGE`: `The user pressed Stop in Firefox. Stop using the browser and ask the user how to continue. Browser calls fail until they press Resume.`;
  - sets the label status to stopped and turns off dialog auto-answering in the session's tabs, so the user handles dialogs.
- Content-script operations run synchronously inside one page task (typing, keys, clicks, drags), so Stop takes effect between operations.
- Resume clears the stopped state, re-enables dialog auto-answering and restores the label. There is no tool to resume.

## 3. Dialogs and settling

### Dialogs

- New content script `content/dialogs.js`, at `document_start` in all frames. It replaces `alert`, `confirm` and `prompt` on the page window with `exportFunction` wrappers, keeping the page's originals on the window (like `console-hook.js` does for console) so re-injection finds them.
- A per-frame flag `enabled` decides at call time. Enabled: `alert` → `undefined`, `confirm` → `true`, `prompt` → its default argument or `""`; each answer is posted as `{ type: "dialog", kind, message, answer }`. Disabled: the original runs.
- The flag comes from the background: each frame asks on start (`{ type: "dialogs.query" }`, answered from `sender.tab`), and the background broadcasts `dialogs.enable` to all frames of a tab when it joins or leaves a session and on stop/resume. Known gap: a dialog raised by the page's first scripts, before the answer arrives, opens normally.
- `beforeunload`: the script adds a capture listener on `window` before page scripts run; when enabled it calls `stopImmediatePropagation()`, so page handlers cannot request the "Leave page?" prompt.
- The background collects dialog reports per tab; the next result of a call on that tab ends with one block per dialog: `Dialog: confirm("Delete this item?") → OK`, `Dialog: alert("Saved") → dismissed`, `Dialog: prompt("Name?") → "Ada"`.

### Settling after actions

- New module `background/navigation.js` holds the navigation waiting code moved out of `tools/tabs.js` (`waitForNavigation`, `tabShowing`, `framesSettled`) plus `watchNavigation(api, tabId, signal)`.
- For `left_click`, `right_click`, `double_click`, `triple_click`, `key` and `type`, `computer` starts watching before the action, then calls `settle()`:
  - a same-document change already seen → `→ URL changed to <url>`;
  - a load started (now or within 500 ms) → wait up to 10 s for it, then for the tab to show it and for iframes, → `→ Navigated to <url> — "<title>"` or `→ Still loading after 10s: <url>`;
  - nothing within 500 ms → no suffix.
- Reload chords use the same wait.
- The abort signal ends any wait early.

## 4. Tool improvements

- **Lenient arguments** (`host/src/coerce.js`, applied in `callTool` before validation): a JSON string where an object or array is expected is parsed; `"true"`/`"false"` become booleans where a boolean is expected; numeric strings become numbers where a number or integer is expected, including array items. `browser_batch` actions and each action's `input` are coerced the same way through `callTool`.
- **`read_page` states**: `(expanded)` / `(collapsed)` from `aria-expanded` and `<details open>`, `(selected)` from `aria-selected="true"`, `(pressed)` from `aria-pressed="true"`. Links print the resolved absolute `href` (`el.href` when it is a string).
- **`form_input` on wrappers**: when the ref is not itself a supported control, the single supported control inside it (light DOM and shadow roots) is used and the result says `(used the <input> inside ref_N)`. Zero controls keeps the current error; more than one fails with `ref_N contains N form controls; pass the ref of one of them`.
- **Console stack traces**: Error arguments and uncaught errors include up to 10 stack lines when the page error's `stack` is readable through the Xray.
- **Hover** waits 300 ms after dispatching before returning.
- **`wait`** accepts up to 30 s; the MCP server's timeout for that call grows to the duration plus 10 s.

## 5. Own strings and styles

- `get_page_text` chooses the longest of `main`, `[role=main]` and `article` when it has at least 200 characters of text, else `body`.
- Redaction marker: `(sensitive value hidden)` in `read_page`; `form_input` prints `(hidden)` for sensitive values and `Selected an option (sensitive field; values hidden)` for sensitive selects.
- `form_input` messages: `A checkbox needs true or false`; `No option matches "x". Options: "Text" = "value"; …`; sensitive: `No option matches (options of a sensitive field are not listed)`.
- Indicator: violet `#7C5CFF` glow (`inset 0 0 0 2px` plus a soft `inset 0 0 28px` halo) and a white cursor with a violet outline.
- The image-size limits in `capture.js` and `geometry.js` are API facts and stay.

## Testing

- Unit tests for every module change (fake `api` objects as today, jsdom for content scripts).
- E2E (real Firefox Developer Edition) additions: session window creation and ownership; `document.visibilityState` of a session tab is `visible` while the window is unfocused; a click that submits a form reports the navigation; `confirm` auto-answer is reported; a page `beforeunload` handler is suppressed; Claude's click on the pill position reaches the page; `read_page` states; lenient arguments; `form_input` on a wrapper; console stack lines.
- Not automatable, checked by hand once and recorded in the plan's ledger: a real (trusted) click on Stop and Resume, and session recovery after an add-on reload (recovery logic itself is unit-tested).

## Verify during implementation

- `windows.create({ focused: false })` keeps the user's window in front on macOS.
- An unfocused session window's active tab reports `visibilityState === "visible"`.
- `sessions.getWindowValue` returns values after an add-on reload.
- Error `stack` is readable through Xrays.
- 500 ms catches a form submit handler that calls `location.assign`.

If a session window turns out to be throttled anyway, the fallback is focusing it once when it is created.
