# Claude in Firefox — Design

Date: 2026-10-17
Status: Draft for review

## 1. Goal

Let Claude Code drive the user's everyday Firefox — real profile, real logins — through MCP tools that mirror the Claude in Chrome (CiC) MCP tool surface, without any domain blocklist.

**Success criteria**

- `claude mcp add firefox …` once; afterwards every Claude Code session can call `mcp__firefox__*` tools against Firefox Developer Edition with the extension installed.
- Each Claude Code session works in its own Firefox tab group and cannot touch tabs outside it.
- Every tool listed in §5 passes the end-to-end suite in §9 against the fixture pages.
- No URL is refused because of its domain or category.

**Non-goals**

- A sidebar chat / in-extension agent loop (Claude Code is the only driver).
- Anthropic OAuth, the cloud WebSocket bridge, or pairing with Claude Desktop.
- Domain blocklists, site categories, enterprise `blockedUrlPatterns`, per-site permission prompts.
- `gif_creator`, `upload_image`, `shortcuts_*`, `update_plan`, `turn_answer_start`, `switch_browser`.
- Trusted (OS-level) input. Input is synthesized in the page; a WebDriver BiDi backend may be added later behind the same module boundary (§6.1) but is not part of this design.
- Multiple simultaneous Firefox profiles running the extension (only the first one to start owns the socket; §7).
- Chrome support, AMO publication, signing.

## 2. Constraints

- Firefox Developer Edition ≥ 139 on macOS (the user's machine). 139 is the first release with both `tabs.group()` and the `tabGroups` API.
- Unsigned extension installed permanently with `xpinstall.signatures.required=false`.
- WebExtension Manifest V2 (persistent background page). Reasons: a long-lived native port with no event-page lifecycle; `tabs.executeScript({code})` for `javascript_tool`; Firefox continues to support MV2.
- Firefox gives extensions no `chrome.debugger` equivalent → no CDP, no trusted input events.
- Native messaging: a single message **from the host to Firefox** is capped at 1 MB; Firefox → host is effectively unbounded.
- Runtime: Node ≥ 20. Package manager: npm. Language: plain JavaScript (ES modules in Node and in the background page; classic scripts for content scripts, which MV2 cannot load as modules). No bundler, no TypeScript.
- Dependencies: `@modelcontextprotocol/sdk` (runtime); `web-ext`, `jsdom` (dev). Nothing else without asking.

## 3. Architecture

```
Claude Code ──stdio MCP──▶ host/src/mcp-server.js ──unix socket──▶ host/src/native-host.js ──native messaging──▶ Firefox extension
 (one process per session)   (spawned by Claude Code)                 (spawned by Firefox, one per browser)        background page + content scripts
```

### 3.1 Repository layout

```
claude-in-firefox/
  package.json
  README.md
  host/
    src/
      framing.js        # 4-byte length-prefixed JSON codec (stream ↔ messages)
      paths.js          # socket dir/path, native manifest path
      native-host.js    # Firefox stdio ⇄ unix socket server, request routing, chunking
      mcp-server.js     # MCP stdio server: tool schemas, socket client, browser_batch, file reading
      tools.js          # MCP tool definitions (names, descriptions, input schemas)
      install.js        # writes native manifest + wrapper, prints `claude mcp add` command
    (install.js copies native-host.js, framing.js, paths.js and a `{ "type": "module" }` package.json to
     ~/Library/Application Support/claude-in-firefox/host/, with a wrapper `native-host`:
     #!/bin/sh exec "<abs node>" "<that dir>/native-host.js" "$@".
     macOS privacy protection stops processes Firefox launches from reading ~/Desktop, ~/Documents and ~/Downloads, so the host cannot run from the repo there.)
  extension/
    manifest.json
    background/
      background.html   # <script type="module" src="main.js">
      main.js           # wiring only
      native.js         # native port with reconnect backoff
      reassemble.js     # part-message reassembly
      dispatch.js       # tool lookup, ownership check, per-tab serialization
      sessions.js       # session ↔ tab group ownership, opener-tab adoption
      content.js        # sendMessage-to-frame helper with on-demand injection
      activity.js       # indicator show/hide around tool calls
      guard.js          # domain-change guard
      tree.js           # tree rendering, find scoring, ref parsing
      geometry.js       # screenshot sizing, coordinate mapping
      capture.js        # screenshots, zoom, per-tab coordinate frames
      logs.js           # console + network ring buffers
      tools/*.js        # one module per tool family
    content/            # classic scripts, all attach to globalThis.__cf
      console-hook.js   # document_start, all frames
      dom.js            # shared helpers: native value setter, host guard
      tree.js           # accessibility tree nodes + ref map
      form.js           # form_input, file_upload target handling
      text.js           # get_page_text
      input.js          # synthetic mouse/keyboard + default-action emulation
      indicator.js      # glow + phantom cursor (top frame only)
      router.js         # runtime.onMessage → __cf op dispatch (loaded last)
  test/
    unit/*.test.js      # node --test
    e2e/                # fixture server, MCP-client driven suite
  docs/
```

### 3.2 Processes

**`native-host.js`** — started by Firefox via the native-messaging manifest (`argv`: manifest path, extension id).

- Socket: `/tmp/claude-firefox-bridge-<uid>/bridge.sock`. A fixed `/tmp` path (not `$TMPDIR`) because the Firefox-spawned and Claude-Code-spawned processes must agree and Claude Code may override `TMPDIR`. Directory created with mode 0700 and verified to be owned by the current uid and not a symlink; socket chmod 0600.
- On start, if the socket path exists: try to connect. If the connection is refused, unlink it and listen. If it connects, another host owns it → log to stderr and exit 1 (the extension will retry).
- Assigns each connected MCP client a numeric `clientId`. Rewrites request ids to `"<clientId>:<id>"` before forwarding to Firefox and routes results back by that prefix.
- Sends `{type:"session_closed", sessionId}` to Firefox when a client disconnects.
- Splits any host→Firefox message whose serialized size exceeds 900 000 bytes into `part` messages (§4.3).
- Exits when stdin ends (Firefox closed the port), removing the socket file.

**`mcp-server.js`** — registered with `claude mcp add --scope user firefox -- node <abs>/host/src/mcp-server.js`.

- On start: `sessionId = crypto.randomUUID()`.
- Connects lazily to the socket on the first tool call; on failure returns the not-connected error (§8). Reconnects on the next call after a drop.
- Sends `{type:"hello", sessionId}` once per connection.
- Exposes the tools in `tools.js`. `browser_batch` and the file-reading half of `file_upload` are executed here; everything else is forwarded.
- Per-call timeout 30 s (`browser_batch`: 90 s). On timeout, returns `isError` and drops the late result.

**Extension background (`main.js`)**

- `browser.runtime.connectNative("claude_firefox_bridge")` at startup. On disconnect, reconnect with backoff 1 s × 2ⁿ capped at 30 s; reset on the first message received.
- Reassembles `part` messages, dispatches `call` messages to tool modules, posts `result` messages.
- Tool calls for the same tab run serially (per-tab promise chain); different tabs run concurrently.

## 4. Wire protocol

All three links carry JSON objects. Link framing: native messaging uses Firefox's 4-byte native-endian length prefix; the unix socket uses the same 4-byte little-endian prefix (`framing.js` serves both).

### 4.1 MCP server ⇄ native host (socket)

| Direction | Message |
|---|---|
| client → host | `{type:"hello", sessionId}` |
| client → host | `{type:"call", id, sessionId, tool, args}` |
| host → client | `{type:"result", id, content, isError}` |

`content` is an MCP content array: `{type:"text", text}` and `{type:"image", data:<base64>, mimeType}` blocks.

### 4.2 Native host ⇄ extension

| Direction | Message |
|---|---|
| host → ext | `{type:"call", id:"<clientId>:<id>", sessionId, tool, args}` |
| host → ext | `{type:"session_closed", sessionId}` |
| host → ext | `{type:"part", msgId, index, total, data}` (see 4.3) |
| ext → host | `{type:"result", id, content, isError}` |

### 4.3 Chunking (host → Firefox only)

If the UTF-8 size of `JSON.stringify(msg)` exceeds 900 000 bytes, the host slices that JSON string into chunks of 250 000 UTF-16 code units and sends one `{type:"part", msgId, index, total, data}` per chunk. Re-serialized inside a part, a code unit costs at most 3 bytes (6 for a lone surrogate at a cut), so every part stays under Firefox's 1 MiB limit. The extension buffers by `msgId` and `JSON.parse`s the joined string when all parts arrive. Buffers older than 60 s are discarded.

## 5. Tool surface

Names drop CiC's `_mcp` suffix. Parameter names, enums and ranges match CiC so model familiarity transfers; descriptions are written fresh. Every tool except `tabs_context`, `tabs_create`, `browser_batch` requires `tabId`, and `tabId` must belong to the calling session's group (§6.4).

| Tool | Input | Behavior / output |
|---|---|---|
| `tabs_context` | `createIfEmpty?: boolean` | `{"availableTabs":[{tabId,title,url}],"tabGroupId"}` for this session. If no group exists: with `createIfEmpty`, create a blank tab in the last-focused normal window and group it; without, return a message telling the model to pass `createIfEmpty: true`. |
| `tabs_create` | — | New blank tab in the session group's window, added to the group, not activated. Error if no group. → `Created tab <id>`. |
| `tabs_close` | `tabId` | Closes a tab in the group. |
| `navigate` | `url`, `tabId` | `"back"`/`"forward"` → `tabs.goBack/goForward`. Otherwise prefix `https://` when no scheme and `tabs.update({url})`. Waits for `status:"complete"` up to 15 s. → `Navigated to <url> — "<title>"` (or a note that loading is still in progress after 15 s). |
| `computer` | `action` ∈ `left_click, right_click, double_click, triple_click, type, key, screenshot, wait, scroll, scroll_to, hover, left_click_drag, zoom`; `coordinate [x,y]`, `start_coordinate`, `ref`, `text`, `modifiers`, `scroll_direction` (up/down/left/right), `scroll_amount` (1–10, default 3), `duration` (0–10 s), `region [x0,y0,x1,y1]`, `repeat` (1–100), `scale` (0.1–1), `tabId` | §6.1–6.2. `ref` and `coordinate` are mutually exclusive. `scroll` returns a fresh screenshot. |
| `read_page` | `tabId`, `filter?: "interactive"\|"all"` (default all), `depth?` (default 15), `ref_id?`, `max_chars?` (default 50 000) | §6.3. Tree text + `\n\nViewport: WxH`. |
| `find` | `query`, `tabId` | Keyword scoring over the tree (§6.3). Up to 20 hits `- ref_N: role "name" …`. Description states it is keyword-based. |
| `form_input` | `ref`, `value: string\|boolean\|number`, `tabId` | §6.5. |
| `get_page_text` | `tabId`, `max_chars?` (default 50 000) | §6.6. |
| `javascript_tool` | `action: "javascript_exec"`, `text`, `tabId` | §6.7. |
| `read_console_messages` | `tabId`, `onlyErrors?`, `clear?`, `pattern?` (regex, case-insensitive; substring fallback if invalid), `limit?` (default 100) | §6.8. |
| `read_network_requests` | `tabId`, `urlPattern?` (substring), `clear?`, `limit?` (default 100) | §6.8. |
| `resize_window` | `width`, `height`, `tabId` | `windows.update` on the tab's window; max 7680×4320. |
| `file_upload` | `paths: string[]`, `ref`, `tabId` | MCP server reads files (total ≤ 10 MB, regular files only), sends `{name, mimeType, base64}` to the extension, which sets `input.files` via `DataTransfer` and dispatches `input` + `change`. Target must be `<input type=file>`. |
| `browser_batch` | `actions: [{name, input}]` (1–50) | Runs sequentially in the MCP server; stops at the first error; concatenates `[i:name] text` lines and all images. Nested `browser_batch` rejected. |

## 6. Extension internals

### 6.1 Input synthesis (`content/input.js`)

The only module that produces input. Operations: `click(target, button, count, modifiers)`, `move(target)`, `drag(from, to)`, `wheel(target, dx, dy)`, `typeText(text)`, `pressKeys(spec, repeat)`.

**Target resolution**

- Coordinates arrive already mapped to CSS viewport pixels (§6.2).
- `document.elementFromPoint(x, y)`; while the hit element has an open `shadowRoot`, recurse with `shadowRoot.elementFromPoint`. If the hit is a same-origin `<iframe>`, recurse into `contentDocument` with coordinates offset by the iframe's content-box origin.
- Cross-origin `<iframe>`: the top frame calls `browser.runtime.getFrameId(iframe)` and returns `{redirect: {frameId, x, y}}` with local coordinates; the background re-sends the operation to that frame.
- `ref` targets resolve through the ref map (§6.3), are scrolled into view (`block/inline: "center"`, instant), and use the center of `getBoundingClientRect()`.

**Mouse**

- Click sequence on the hit element: `pointerover, pointerenter, mouseover, mouseenter, pointermove, mousemove, pointerdown, mousedown`, then `focus()` on the nearest focusable ancestor if `mousedown` was not cancelled, then `pointerup, mouseup, click` (`detail` = 1..count). `dblclick` after the second click. `right_click` → `pointerdown/mousedown/pointerup/mouseup` with `button:2` then `contextmenu`. All events carry `clientX/Y`, `screenX/Y`, `button`, `buttons`, and modifier flags; `bubbles`, `cancelable`, `composed: true`.
- `triple_click` additionally selects the containing paragraph/line text (input/textarea: `select()`; otherwise a `Range` over the block ancestor).
- New-tab links: those whose `target` is not `_self`/`_parent`/`_top`, middle clicks, and clicks with ctrl/cmd held. A bubble-phase `click`/`auxclick` listener on `window` runs after the page's own handlers and checks `defaultPrevented`. If the page did not cancel the click, it calls `preventDefault()` and the background opens `href` in a new tab in the session group. The tool output appends `(link opened in new tab <id>)`.
- `hover`: `pointerover, pointerenter, mouseover, mouseenter, pointermove, mousemove`.
- `left_click_drag`: `pointerdown/mousedown` at start; five interpolated `pointermove/mousemove` with `buttons:1`; `pointerup/mouseup` at end. If the start element (or ancestor) is `draggable`, also dispatch `dragstart` → `drag` → `dragenter`/`dragover` on the drop target → `drop` → `dragend`, sharing one `DataTransfer`.

**Keyboard**

- Key spec grammar: whitespace-separated tokens; each token is `mod+mod+key`. Modifiers: `ctrl|control`, `shift`, `alt|option`, `cmd|meta|command|super|win`. Key names are case-insensitive and accept xdotool forms (`Return`, `BackSpace`, `Page_Down`, `KP_Enter`, `Escape`, `space`, `Left`, `F1`–`F12`, punctuation by symbol or name). Unknown key → error `Unknown key: <token>` (never typed literally).
- Each token: dispatch `keydown` (and `keypress` for printable keys) then `keyup` on `document.activeElement` (or `body`), with `key`, `code`, `keyCode`/`which`, modifier flags.
- If `keydown` was not cancelled, emulate the default action:

| Key | Default-action emulation |
|---|---|
| printable (no ctrl/cmd) | `execCommand("insertText", false, ch)` |
| Enter | input in a form → `form.requestSubmit()`; textarea/contenteditable → `execCommand("insertLineBreak")`; focused link/button → `click()` sequence |
| Tab / shift+Tab | focus next/previous element in sequential tab order (tabindex ≥ 0, focusable, visible) |
| Backspace / Delete | `execCommand("delete")` / `execCommand("forwardDelete")` |
| Left/Right/Home/End (+shift) | text controls: move/extend selection via `setSelectionRange`; contenteditable: `Selection.modify` |
| Up/Down/PageUp/PageDown/Space/Home/End (non-editable focus) | scroll the nearest scrollable ancestor (40 px per arrow, 0.875 × viewport per page) |
| Escape | none |
| cmd/ctrl + a / c / x / z / shift+z | `selectAll` / `copy` / `cut` / `undo` / `redo` via `execCommand` (or `select()` in text controls) |
| cmd/ctrl + r, F5 | background `tabs.reload` (+shift → `bypassCache`) |
| page-zoom chords (cmd/ctrl + `=`,`-`,`0`) | error: unsupported, use `zoom` action |

- On macOS the platform modifier for shortcuts is `cmd`; `ctrl` chords map to the same emulation so either works.
- `type`: for each character, `keydown`, then (if not cancelled) `execCommand("insertText")`, then `keyup`. `\n` is handled as Enter. If `insertText` returns false (non-editable target), fall back to the native value setter for `input/textarea` (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`) plus `input` event.

**Scroll**

- Dispatch `WheelEvent` (`deltaMode: 0`, delta = amount × 100 px) at the point. If not cancelled, `scrollBy` the nearest scrollable ancestor of the hit element in that axis (overflow `auto|scroll` and scrollable extent > client size), else the window. Wait 200 ms, then attach a screenshot.

**Known limitations (documented in README and tool descriptions where relevant)**

- Events are `isTrusted: false`; handlers that check it ignore them.
- CSS `:hover`/`:active` do not apply.
- Native `<select>` popups and file pickers cannot be opened (use `form_input` / `file_upload`).
- Clipboard paste is unavailable.

### 6.2 Screenshots and coordinates (`background/capture.js`)

- Viewport probe (content op): `innerWidth`, `innerHeight`, `devicePixelRatio`.
- Target size: largest `(w, h)` with the viewport's aspect ratio such that `w ≤ 1568`, `h ≤ 1568`, and `ceil(w/28) · ceil(h/28) ≤ 1568`. Then multiply by the `scale` argument (default 1).
- Capture: `browser.tabs.captureTab(tabId, {format:"jpeg", quality:75, scale: targetW / innerWidth})`. (`ImageDetails.scale` is relative to CSS pixels.) If the base64 exceeds 1 398 100 chars, retry with quality −10 down to 25.
- Before capture: hide the indicator (content op); restore afterwards in `finally`. No paint wait: `captureTab` renders the document directly (spike probe Q1d confirms).
- Coordinate context per tab: `{cssW, cssH, shotW, shotH}` from the last full-frame screenshot (the unscaled frame size when `scale < 1`). Model coordinates map as `x_css = round(x · cssW / shotW)`, same for y. Coordinates outside `[0, shotW] × [0, shotH]` → error asking for a fresh screenshot. With no screenshot yet, coordinates are treated as CSS pixels.
- `zoom`: `captureTab` with `rect` = region mapped to CSS px and a scale sized to the target budget for that region; PNG; does not change the coordinate context.
- Output text: `Screenshot <shotW>x<shotH> (jpeg)` (+ `, scaled <s>; coordinates use the <W>x<H> frame` when `scale < 1`).
- **Fallback (decided by the spike, §10)**: if `captureTab` returns a blank image for background tabs, capture activates the tab, captures, and re-activates the previously active tab in that window.

### 6.3 Accessibility tree, refs, find (`content/tree.js`)

Builds a node list, then renders text. Same text format as CiC so the model's expectations transfer:

```
<indent>role "name" [ref_N] (checked) (selected) (disabled) href="…" type="…" placeholder="…" value="…"
```

- **Refs**: per-frame `Map<string, WeakRef<Element>>` + `WeakMap<Element, string>`; ids are `ref_<counter>` and stable for an element across calls. Refs created inside a non-top frame are prefixed `f<frameId>_ref_N` so the background can route them; top-frame refs stay `ref_N`. Dead entries pruned after each build.
- **Roles**: explicit `role` attribute; else tag map (a[href]→link, button, select→combobox, textarea→textbox, input by type → textbox/checkbox/radio/button/searchbox/slider/spinbutton, h1–h6→heading, img→image, nav, main, header→banner, footer→contentinfo, section→region, article, aside→complementary, form, table, ul/ol→list, li→listitem, label, dialog, details→group, summary→button, option); else `generic`.
- **Names** (first non-empty): `aria-labelledby` texts; `aria-label`; for inputs `<label for>` or wrapping `<label>` text; `placeholder`; `title`; `alt`; buttons, links, summary, headings and other name-from-content roles → descendant text (whitespace-collapsed, 100 chars); submit/button input values; fallback direct text ≥ 3 chars. Label text excludes the control's own text. Text-field values are not names: they render as a separate `value="…"` (100 chars), shown as `[value redacted]` for sensitive fields.
- **Sensitive**: `type` password/hidden, or `autocomplete` containing `current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`.
- **Inclusion**: skip `script, style, meta, link, title, noscript, template` and the indicator host element. `filter:"interactive"` keeps interactive elements that are visible and intersect the viewport (unless `ref_id` given). `filter:"all"` keeps interactive, landmark/structural, named, or non-generic nodes, including hidden ones.
- **Traversal**: depth-first over children; flatten unnamed generic wrappers (depth increases only for emitted nodes); descend into open shadow roots and same-origin iframe documents; cross-origin iframes are emitted as `iframe "<src>" [frame <frameId>]` and their contents are fetched from that frame and spliced in at that position. Cap 10 000 nodes; `max_chars` truncation at a line boundary with the same guidance note as CiC.
- `<select>` options rendered as children `option "text" (selected) value="v"`, not re-emitted as generics.
- **find**: tokenize the query (lowercase, split on non-alphanumerics, drop stopwords `the a an to of for in on with`). Score each node: +5 if the full query phrase appears in the name; +3 per token in name; +2 per token matching the role or a role synonym (`button↔btn`, `link↔anchor`, `textbox↔input|field|box|bar|search`, `combobox↔dropdown|select`, `checkbox↔check`); +1 per token in placeholder/href/type; +1 if interactive. Return the top 20 with score > 0, ties broken by document order. 0 hits → `No elements matched "<query>"`.

### 6.4 Sessions and tab groups (`background/sessions.js`)

- `sessionId → groupId` in memory only (an extension reload forgets it; the session then calls `tabs_context {createIfEmpty:true}` again). Group title `Claude · <first 4 chars of sessionId>`, colors rotating through `orange, blue, green, purple, cyan, pink, yellow, red`.
- Ownership check before every tab-scoped tool: `tabs.get(tabId).groupId === session.groupId`, else `Tab <id> is not in this session's tab group. Valid tab IDs: …`.
- `tabs.onCreated` with an `openerTabId` inside a session group → add the new tab to that group.
- If the user drags a tab out of the group it is no longer controllable; if the group is removed the session has no group until `tabs_context {createIfEmpty:true}`.
- `session_closed` → forget the mapping; leave the tabs and group in place.

### 6.5 form_input (`content/form.js`)

- Resolve ref (same errors as CiC: removed / no longer exists); `scrollIntoView({block:"center"})`; `focus()`.
- `select`: match option by exact value, then exact text, then case-insensitive trimmed text; set `selected`; error lists available options.
- checkbox: boolean required; set `checked` only if different, dispatching `click` so frameworks see it.
- radio: `click()` if not checked.
- text-like inputs, textarea: native prototype value setter, then `input` then `change` (bubbling). number/range validated numeric.
- date/time/month/week/datetime-local/color: native setter + `input` + `change`.
- `contenteditable`: select all contents, `execCommand("insertText", false, value)`.
- Output: `Set <kind> to "<value>" (previous: "<prev>")`; sensitive fields render both as `[redacted]`.

### 6.6 get_page_text (`content/text.js`)

CiC's heuristic: first matching selector of `article, main, [class*="articleBody"], [class*="article-body"], [class*="post-content"], [class*="entry-content"], [class*="content-body"], [role="main"], .content, #content`, taking the match with the longest `innerText`; else `body`. Normalize whitespace; < 10 chars → "No text content found…". Output `Title: …\nURL: …\nSource element: <tag>\n---\n<text>` with `max_chars` truncation at a line boundary.

### 6.7 javascript_tool (`background/tools/javascript.js`)

1. **Page realm first.** The `tabs.executeScript` code calls `window.eval` on a small program that runs in the page. That program indirect-evals the user code, awaits the result, and serializes it in the page. It then hands the JSON back through a `CustomEvent` with a string `detail`. A string crosses the content-script boundary unchanged; page objects and page Promises do not reliably.
2. **Sandbox fallback.** If `window.eval` itself throws (the page CSP forbids eval), rerun the user code directly as the `executeScript` `code`, in the content-script realm, which page CSP does not cover.
   - Page objects are then reachable via `window.wrappedJSObject`.
   - The completion value must be structured-cloneable.
   - The output is prefixed `[ran in extension sandbox: page CSP blocks eval; use window.wrappedJSObject for page globals]`.
3. **Top-level `await` or `return`.** A `SyntaxError` about either → rerun wrapped as `(async () => { <code> })()`, with a note that `return` produces the value.
4. **Serializer.**
   - JSON with depth 5.
   - Strings over 1000 chars and arrays over 100 items are truncated.
   - Functions and DOM nodes are described (`[Function name]`, `<tag#id.class>`).
   - Total output ≤ 51 200 chars.
   - Errors → `isError` with the message and the head of the stack.
   - Execution timeout 25 s, inside the MCP server's 30 s.

Exact realm behavior is verified in the spike; the spec's fallback chain stands either way.

### 6.8 Console and network logs (`content/console-hook.js`, `background/logs.js`)

- **Console** (MV2 isolated content script, `document_start`, all frames, `match_about_blank`): for `log, info, warn, error, debug`, replace `window.wrappedJSObject.console[level]` with an `exportFunction`-ed wrapper that records `{level, text, url, line?}` then calls the original. Also listens for window `error` and `unhandledrejection`. Argument stringification: strings verbatim; Error → `name: message`; others `JSON.stringify` with fallback `String()`; message capped at 16 384 chars. Batched to the background every 250 ms.
- **Network**: `webRequest.onBeforeRequest` / `onCompleted` / `onErrorOccurred` for `<all_urls>`, `tabId ≥ 0` → `{requestId, method, url, type, status|error}`.
- Buffers: per tab, 10 000 console / 1 000 network entries (oldest dropped); reset on `webNavigation.onCommitted` (frameId 0) when the origin changes; deleted on tab close. Capture runs for all tabs from the moment the extension loads.
- Output formats match CiC: `[n] [HH:MM:SS] [LEVEL] (url:line) text` and `n. url: …\n   method: …\n   statusCode: …|pending|failed (<error>)`.

### 6.9 Indicator (`content/indicator.js`, top frame only)

- Host element `<claude-firefox-indicator>` on `documentElement` with a closed shadow root: fixed full-viewport inset orange glow (`pointer-events:none`, max z-index, 2 s pulse, disabled under `prefers-reduced-motion`) and a phantom cursor SVG moved via `transform` to the last pointer target. Styles are set through CSSOM and the pulse uses Web Animations, so a strict page `style-src` cannot block them.
- Shown when a tool starts on the tab; hidden 2 s after the last tool on that tab finishes; hidden around screenshots; re-asserted after navigation (`tabs.onUpdated` status complete) while a session is active on the tab.

### 6.10 Content-script plumbing (`background/content.js`, `content/router.js`)

- `callContent(tabId, frameId, op, args)` → `tabs.sendMessage(tabId, {op, args}, {frameId})`.
- On "Receiving end does not exist", inject all content scripts via `tabs.executeScript({file, frameId, runAt:"document_start"})` in manifest order, then retry once.
- `router.js` maps `op` → `globalThis.__cf.<module>.<fn>`; each content file guards against double-load (`if (globalThis.__cf?.tree) return`).

### 6.11 Guards kept from CiC

- **Redaction** of sensitive field values (§6.3, §6.5).
- **Domain-change guard**: acting operations (`computer` clicks/drag/type/key/scroll, `form_input`, `file_upload`, `javascript_tool`) record the tab's hostname when the tool call starts and re-check it immediately before dispatching input; on mismatch → `Page navigated to a different domain during <action>. Re-read the tab state before retrying.`

No domain is ever refused. The README documents Firefox's own `extensions.webextensions.restrictedDomains` pref (and `privacy.resistFingerprinting.block_mozAddonManager`) for users who want the extension active on Mozilla's restricted sites; the installer does not change Firefox prefs.

## 7. Manifest

```json
{
  "manifest_version": 2,
  "name": "Claude in Firefox",
  "version": "0.1.0",
  "browser_specific_settings": { "gecko": { "id": "claude-firefox-bridge@local", "strict_min_version": "139.0" } },
  "permissions": ["nativeMessaging", "tabs", "tabGroups", "<all_urls>", "webRequest", "webNavigation", "clipboardWrite"],
  "background": { "page": "background/background.html", "persistent": true },
  "content_scripts": [
    { "matches": ["<all_urls>"], "all_frames": true, "match_about_blank": true, "run_at": "document_start",
      "js": ["content/console-hook.js", "content/dom.js", "content/tree.js", "content/form.js", "content/text.js", "content/input.js", "content/router.js"] },
    { "matches": ["<all_urls>"], "run_at": "document_idle", "js": ["content/indicator.js"] }
  ]
}
```

Native host manifest (written by `install.js` to `~/Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json`):

```json
{ "name": "claude_firefox_bridge", "description": "Claude in Firefox bridge", "path": "<home>/Library/Application Support/claude-in-firefox/host/native-host", "type": "stdio", "allowed_extensions": ["claude-firefox-bridge@local"] }
```

The wrapper lives in Application Support rather than the repo because macOS privacy protection stops processes Firefox launches from reading ~/Desktop, ~/Documents and ~/Downloads.

## 8. Error handling

| Situation | Behavior |
|---|---|
| No socket / connect refused | `Firefox extension not connected — is Firefox Developer Edition running with the Claude in Firefox extension installed?` |
| Socket drops mid-call | Pending calls fail with `Connection to Firefox lost`; next call reconnects. |
| Tool timeout (30 s / 90 s) | `isError: <tool> timed out after <n>s`; late result dropped. |
| Native port drops (extension side) | Reconnect with backoff 1 s → 30 s. In-flight calls fail on the host side via socket error. |
| Tab not in session group | Error listing valid tab IDs. |
| Restricted page (`about:*`, `moz-extension:*`, restricted domains) | `Cannot access this page (<url>): Firefox does not allow extensions here.` |
| Content script missing | Inject on demand, retry once (§6.10). |
| Stale ref | `Element ref_N not found — it may have been removed. Call read_page or find again.` |
| Unknown tool / bad args | MCP-side schema validation error; extension re-validates required fields. |
| Second Firefox profile with extension | Its native host exits (socket owned); extension keeps retrying; README notes the limitation. |

## 9. Testing

**Unit (`node --test test/unit`)**

- `framing`: round-trip, partial reads, multiple messages per chunk, size guard.
- `native-host` routing: ids prefixed and routed to the right client; `session_closed` on client disconnect; chunking splits > 900 000-byte messages and reassembly restores them.
- Screenshot target-size math and coordinate mapping (incl. out-of-bounds, `scale < 1`).
- Key spec parser: names, xdotool aliases, chords, unknown keys, zoom-chord rejection.
- Content modules under jsdom: tree roles/names/refs/redaction/select options/shadow DOM/truncation; `find` scoring order; `form_input` per element type incl. native-setter React-style tracker; `get_page_text` selector choice; key default-action emulation where jsdom supports it (`requestSubmit`, focus order, selection).
- `browser_batch` sequencing and stop-on-error (MCP server with a fake socket).

**End-to-end (`npm run e2e`)**

- Fixture server on two ports (`localhost:<a>`, `127.0.0.1:<b>` for a cross-origin iframe) serving: a React-style controlled input (value tracker), a form that only submits via Enter, `<select>`, checkbox/radio, `contenteditable`, a `target=_blank` link, a scrollable div, a draggable item + drop zone, a page that logs to console and fetches `/api/ping`, a strict-CSP page (`script-src 'self'`) for `javascript_tool`, and a file input.
- `web-ext run --firefox "<Developer Edition binary>"` with the extension loaded temporarily and the native manifest installed.
- A Node script using the MCP SDK client spawns `mcp-server.js` and exercises every tool, asserting on DOM state read back via `javascript_tool`/`read_page`.

**Gates**: `npm test`, `npx web-ext lint --source-dir extension`, `npm run e2e` all pass before any phase is called done.

## 10. Delivery phases

0. **Spike (throwaway, not merged)** — in Developer Edition, answer:
   1. Does `tabs.captureTab` render a non-active tab, and a tab in an occluded window, and does `scale` behave as CSS-relative?
   2. Do the §6.1 synthetic click + `execCommand("insertText")` + Enter emulation update a React-controlled input and submit a form?
   3. On a `script-src 'self'` page, does `window.eval` from `tabs.executeScript` fail, and does the sandbox fallback work?
   4. Does the native port stay connected for > 10 minutes idle?
   Outcome changes only the documented fallbacks (§6.2, §6.7). If (2) fails broadly, stop and revisit approach B (BiDi) with the user.
1. **Bridge**: framing, native host, MCP server, installer, `tabs_context`, `tabs_create`, `tabs_close`, `navigate`, sessions/groups. E2E for these.
2. **Reading**: `read_page`, `find`, `get_page_text`, `form_input`, `javascript_tool`.
3. **Input**: `computer` (all actions), capture, indicator.
4. **Rest**: logs, `resize_window`, `file_upload`, `browser_batch`, README.

Installing Firefox Developer Edition (`brew install --cask firefox@developer-edition`) requires the user's go-ahead.

## Appendix A: Spike results (2026-10-17, Firefox Developer Edition 159.0b3)

| Probe | Observed |
|---|---|
| Q1a viewport | innerWidth 1280, innerHeight 955, devicePixelRatio 2 |
| Q1a background tab, scale 1 | 1280x955, distinctColors 10, topLeft `0,0,0` |
| Q1a visible tab, scale 1 | 1280x955, distinctColors 10, topLeft `0,0,0` |
| Q1b background tab, scale 0.5 (jpeg) | 640x477, distinctColors 95, topLeft `0,0,0` |
| Q1c rect after scroll 1000 | 50x50, topLeft `0,0,0` (rect is document-relative) |
| Q1d overlay hidden right before capture | topLeft `0,0,0`, not `255,0,0` |
| Q1e minimized window | captured: 1280x955, distinctColors 15, topLeft `0,0,0` |
| Q2 background tab input | execCommandResults `[true,true]`; value `hi`, value2 `xyz`, changes 2, submitted 1, keydowns 2 |
| Q2 background tab link click | url `http://127.0.0.1:8787/landed.html` |
| Q2 active tab input | execCommandResults `[true,true]`; value `hi`, value2 `xyz`, changes 2, submitted 1, keydowns 2 |
| Q2 active tab link click | url `http://127.0.0.1:8787/landed.html` |
| Q3a window.eval on strict CSP page | `ok: false`, `EvalError: call to eval() blocked by CSP` |
| Q3b wrappedJSObject.pageVar | `42` |
| Q3c event-based page program | `{"ok":true,"v":42}` |
| Q3d sandbox promise result | `7` |
| Q4 native port after 11 min | 12 heartbeats logged, 0 `stdin closed`, 0 `Q4-native-disconnected` |
| Q5 tab groups in MV2 | groupId 1792185247976073 (integer), members `[3]` includes the tab, title `Claude · spik`, color `orange` |
