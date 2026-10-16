# Claude in Firefox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Firefox (MV2) extension plus a local Node MCP bridge that lets Claude Code drive the user's everyday Firefox with tools modeled on Claude in Chrome, with no domain blocking.

**Architecture:** Claude Code spawns `host/src/mcp-server.js` (MCP over stdio). It talks over a private unix socket to `host/src/native-host.js`, which Firefox spawns through native messaging for the extension. The extension's persistent background page routes each tool call to a module that uses WebExtension APIs and content scripts: accessibility tree, synthetic input, forms, page text, indicator and console hook.

**Tech Stack:** Node ≥ 20 (ESM), npm, `@modelcontextprotocol/sdk` v1, Firefox WebExtensions MV2 on Firefox Developer Edition ≥ 139, `web-ext`, `jsdom`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-17-claude-in-firefox-design.md`

## Global Constraints

- macOS, Firefox Developer Edition ≥ 139 (`"strict_min_version": "139.0"`), unsigned install with `xpinstall.signatures.required=false`.
- WebExtension Manifest V2 with a persistent background page.
- Node ≥ 20, npm, plain JavaScript. ES modules in Node and the background page; classic scripts for content scripts. No bundler, no TypeScript.
- Dependencies: `@modelcontextprotocol/sdk@^1` (runtime); `web-ext`, `jsdom` (dev). No other packages without asking the user.
- Extension id `claude-firefox-bridge@local`; native host name `claude_firefox_bridge`; socket `/tmp/claude-firefox-bridge-<uid>/bridge.sock` (directory 0700, socket 0600).
- Host→Firefox native messages over 900 000 bytes are split into `part` messages of at most 250 000 UTF-16 code units.
- No URL is ever refused because of its domain. The only guards are sensitive-value redaction and the domain-changed-mid-action check.
- Timeouts: 30 s per tool call, 90 s per `browser_batch`, 15 s for `navigate` to finish loading, 25 s for `javascript_tool` execution.
- Tool names and parameters exactly as in spec §5.
- Code comments only for constraints the code cannot show. No comments that narrate the change.
- Commit messages are plain. No `Claude-Session:` trailer.
- Writing outside the repo (installing Firefox, the native-messaging manifest under `~/Library`, `claude mcp add`) requires the user's go-ahead first.

## Review Focus

1. **Very large pages.** A `read_page` on a page with more than 10 000 elements should return the "truncated at 10000 elements" note quickly, not hang or overflow. Pinned in Task 7 (a 12 001-node page).
2. **Numbers arriving as strings.** The model may send `"tabId": "123"` or `"coordinate": ["10", "20"]`, and both should still work. Pinned in Task 5 (dispatcher) and Task 14 (computer tool unit test).
3. **Unicode in typed text and in split messages.** Text like "héllo 👋" must survive typing and native-message chunking, including a surrogate pair split across a part boundary. Pinned in Task 1 (framing), Task 11 (typing) and Task 14 (e2e).
4. **Tabs or groups that disappear between calls.** If a tab is closed, or the user removes the whole group, the next call should give a clear error (listing valid tab IDs where possible), never a hang. Pinned in Task 5 (sessions) and Task 6 (e2e).
5. **Firefox restart or extension reload mid-session.** The next tool call should reconnect without restarting Claude Code. Pinned in Task 3 (BridgeClient reconnect).

## File Map

| Path | Responsibility |
|---|---|
| `package.json` | Scripts (`test`, `lint`, `build`, `install-host`, `e2e`) and dependencies |
| `host/src/framing.js` | 4-byte length-prefixed JSON codec; splitting host→Firefox messages into parts |
| `host/src/paths.js` | Names, socket path, native manifest path, socket-directory checks, `isMain` |
| `host/src/native-host.js` | Firefox stdio ⇄ unix socket server; per-client id routing; `session_closed` |
| `host/src/tools.js` | MCP tool names, descriptions, input schemas |
| `host/src/mcp-server.js` | MCP stdio server, `BridgeClient`, `browser_batch`, `file_upload` file reading |
| `host/src/install.js` | Writes the native manifest and wrapper; prints the `claude mcp add` command |
| `extension/manifest.json` | MV2 manifest |
| `extension/background/background.html` | Loads `main.js` as a module |
| `extension/background/main.js` | Wires modules together |
| `extension/background/native.js` | `connectNative` with reconnect backoff and part reassembly |
| `extension/background/reassemble.js` | Pure reassembly of `part` messages |
| `extension/background/dispatch.js` | Tool lookup, ownership check, per-tab serialization, result shaping |
| `extension/background/sessions.js` | Session ⇄ tab-group mapping, ownership, opener-tab adoption |
| `extension/background/content.js` | `call(tabId, frameId, op, args)` with on-demand injection |
| `extension/background/activity.js` | Shows and hides the page indicator around tool calls |
| `extension/background/guard.js` | Hostname helpers and the domain-change guard |
| `extension/background/tree.js` | Pure rendering of tree nodes, `find` scoring, ref parsing, truncation |
| `extension/background/geometry.js` | Pure screenshot sizing and coordinate mapping |
| `extension/background/capture.js` | Screenshots, zoom, per-tab coordinate frames |
| `extension/background/logs.js` | Console and network ring buffers, formatting, listeners |
| `extension/background/tools/tabs.js` | `tabs_context`, `tabs_create`, `tabs_close`, `navigate`, `resize_window` |
| `extension/background/tools/page.js` | `read_page`, `find`, `get_page_text`, `form_input`, `file_upload` |
| `extension/background/tools/javascript.js` | `javascript_tool` |
| `extension/background/tools/computer.js` | `computer` |
| `extension/background/tools/logs.js` | `read_console_messages`, `read_network_requests` |
| `extension/content/console-hook.js` | Wraps page `console.*`, captures errors and rejections |
| `extension/content/dom.js` | Shared helpers: native value setter, contenteditable check, host guard |
| `extension/content/tree.js` | Accessibility-tree nodes, ref map |
| `extension/content/form.js` | `form_input` and file-input logic |
| `extension/content/text.js` | `get_page_text` extraction |
| `extension/content/input.js` | Synthetic keyboard and pointer input with default-action emulation |
| `extension/content/indicator.js` | Glow and phantom cursor (top frame only) |
| `extension/content/router.js` | `runtime.onMessage` → `__cf.<module>.<fn>` (loaded last) |
| `test/unit/*.test.js`, `test/unit/helpers/dom.js` | Unit tests; jsdom loader for content scripts |
| `test/e2e/harness.js`, `fixtures.js`, `pages/*`, `e2e.test.js` | End-to-end against real Firefox Developer Edition |
| `README.md` | Install, usage, safety, limitations, development |

## Conventions for Every Task

- Unit tests: `npm test`. End-to-end: `npm run e2e`. E2E needs Firefox Developer Edition installed, `npm run install-host` already run, and no other Firefox Developer Edition running the extension.
- Stage only the files the task lists, then commit with the message given.
- Content scripts are classic scripts. Each wraps itself in an IIFE, exits early if its module already exists on `globalThis.__cf`, and attaches its API to `globalThis.__cf.<module>`. The router calls `__cf.<module>.<fn>(args)` for an op named `"<module>.<fn>"`.
- Background tool modules export factories that return `{ <toolName>: { tabScoped: boolean, run(ctx) } }`. `ctx` is `{ sessionId, args, tab? }`, and `tab` is present when `tabScoped`. `run` returns a string or an array of MCP content blocks (`{type:"text",text}` / `{type:"image",data,mimeType}`).

---
### Task 0: Feasibility spike (throwaway)

Answers spec §10's five questions in real Firefox Developer Edition before any product code exists. None of this code is committed. Only the results are, as an appendix to the spec.

**Files:**
- Create (outside the repo, in a scratch directory `$SPIKE`): `package.json`, `server.mjs`, `pages/{bands,react,landed,csp}.html`, `pages/csp.js`, `ext/manifest.json`, `ext/background.js`, `host/host.mjs`, `host/host.sh`
- Create (user-approved, outside the repo): `~/Library/Application Support/Mozilla/NativeMessagingHosts/cf_spike.json`
- Modify: `docs/superpowers/specs/2026-10-17-claude-in-firefox-design.md` (append "Appendix A: Spike results")

**Interfaces:**
- Consumes: nothing
- Produces: an observed-results table that later tasks rely on (see Step 9)

- [ ] **Step 1: Get approval and install Firefox Developer Edition**

Ask the user: "OK to run `brew install --cask firefox@developer-edition` and to write a temporary native-messaging manifest `cf_spike.json` into `~/Library/Application Support/Mozilla/NativeMessagingHosts/`?" Continue only after a yes.

```bash
brew install --cask firefox@developer-edition
"/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox" --version
```
Expected: `Mozilla Firefox 1xx.0b…` with a major version ≥ 139.

- [ ] **Step 2: Create the spike workspace**

Pick a scratch directory outside the repo, for example the session scratchpad, and export it as `SPIKE`.

```bash
export SPIKE="<scratch dir>/spike" && mkdir -p "$SPIKE"/{pages,ext,host} && cd "$SPIKE"
printf '{ "private": true, "type": "module" }\n' > package.json
npm install react@18.3.1 react-dom@18.3.1 web-ext@8
```

- [ ] **Step 3: Write the probe server and pages**

`$SPIKE/server.mjs`:
```js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = {
  "/vendor/react.js": "node_modules/react/umd/react.development.js",
  "/vendor/react-dom.js": "node_modules/react-dom/umd/react-dom.development.js",
};
const results = [];

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/report") {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const entry = JSON.parse(body);
      results.push(entry);
      console.log(JSON.stringify(entry));
      fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(results, null, 2));
      res.end("ok");
    });
    return;
  }
  const file = VENDOR[url.pathname] ? path.join(DIR, VENDOR[url.pathname]) : path.join(DIR, "pages", url.pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  const headers = { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" };
  if (url.pathname.startsWith("/csp")) headers["content-security-policy"] = "script-src 'self'";
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(8787, "127.0.0.1", () => console.log("spike server on http://127.0.0.1:8787"));
```

`$SPIKE/pages/bands.html` (band *i* is `rgb(i*23 % 256, i*71 % 256, i*131 % 256)`: band 0 is `0,0,0`, band 10 is `230,198,30`):
```html
<!doctype html><title>Bands</title>
<style>body{margin:0} div{height:100px}</style>
<div id="overlay" style="position:fixed;inset:0;background:rgb(255,0,0);display:none"></div>
<script>
  for (let i = 0; i < 60; i++) {
    const d = document.createElement("div");
    d.style.background = `rgb(${(i * 23) % 256}, ${(i * 71) % 256}, ${(i * 131) % 256})`;
    document.body.append(d);
  }
</script>
```

`$SPIKE/pages/react.html`:
```html
<!doctype html><title>React</title>
<div id="root"></div>
<a id="samepage" href="/landed.html">same tab link</a>
<script src="/vendor/react.js"></script>
<script src="/vendor/react-dom.js"></script>
<script>
  window.__state = { value: "", value2: "", changes: 0, submitted: 0, keydowns: 0 };
  const e = React.createElement;
  function App() {
    const [value, setValue] = React.useState("");
    const [value2, setValue2] = React.useState("");
    return e("form", { onSubmit: (ev) => { ev.preventDefault(); window.__state.submitted++; } },
      e("input", { id: "name", value, onKeyDown: () => { window.__state.keydowns++; }, onChange: (ev) => { window.__state.changes++; window.__state.value = ev.target.value; setValue(ev.target.value); } }),
      e("input", { id: "name2", value: value2, onChange: (ev) => { window.__state.value2 = ev.target.value; setValue2(ev.target.value); } }),
      e("button", { type: "submit" }, "Go"));
  }
  ReactDOM.createRoot(document.getElementById("root")).render(e(App));
</script>
```

`$SPIKE/pages/landed.html`:
```html
<!doctype html><title>Landed</title><p>landed</p>
```

`$SPIKE/pages/csp.html` (served with `script-src 'self'`):
```html
<!doctype html><title>CSP</title><script src="/csp.js"></script><p>csp page</p>
```

`$SPIKE/pages/csp.js`:
```js
window.pageVar = 42;
```

- [ ] **Step 4: Write the spike native host**

`$SPIKE/host/host.mjs`:
```js
import fs from "node:fs";

const LOG = new URL("./host.log", import.meta.url);
const log = (line) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
log(`started pid=${process.pid} args=${JSON.stringify(process.argv.slice(2))}`);
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    log(`message ${buf.subarray(4, 4 + len).toString()}`);
    buf = buf.subarray(4 + len);
  }
});
process.stdin.on("end", () => { log("stdin closed"); process.exit(0); });
```

```bash
printf '#!/bin/sh\nexec "%s" "%s/host/host.mjs" "$@"\n' "$(command -v node)" "$SPIKE" > "$SPIKE/host/host.sh"
chmod 755 "$SPIKE/host/host.sh"
mkdir -p ~/Library/Application\ Support/Mozilla/NativeMessagingHosts
cat > ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/cf_spike.json <<EOF
{ "name": "cf_spike", "description": "spike", "path": "$SPIKE/host/host.sh", "type": "stdio", "allowed_extensions": ["cf-spike@local"] }
EOF
```

- [ ] **Step 5: Write the spike extension**

`$SPIKE/ext/manifest.json`:
```json
{
  "manifest_version": 2,
  "name": "cf spike",
  "version": "0.0.1",
  "browser_specific_settings": { "gecko": { "id": "cf-spike@local", "strict_min_version": "139.0" } },
  "permissions": ["<all_urls>", "tabs", "tabGroups", "nativeMessaging"],
  "background": { "scripts": ["background.js"], "persistent": true }
}
```

`$SPIKE/ext/background.js`:
```js
const BASE = "http://127.0.0.1:8787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (name, data) => fetch(`${BASE}/report`, { method: "POST", body: JSON.stringify({ name, data }) }).catch(() => {});
const exec = async (tabId, code) => (await browser.tabs.executeScript(tabId, { code }))[0];

async function open(url, active) {
  const tab = await browser.tabs.create({ url: BASE + url, active });
  for (let i = 0; i < 100; i++) {
    if ((await browser.tabs.get(tab.id)).status === "complete") break;
    await sleep(100);
  }
  await sleep(300);
  return tab;
}

async function stats(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4 * 1009) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  const p = ctx.getImageData(2, 2, 1, 1).data;
  return { width: img.width, height: img.height, distinctColors: colors.size, topLeft: `${p[0]},${p[1]},${p[2]}` };
}

async function step(name, fn) {
  try { await report(name, await fn()); } catch (err) { await report(name, { threw: String(err) }); }
}

async function main() {
  const port = browser.runtime.connectNative("cf_spike");
  port.onDisconnect.addListener((p) => report("Q4-native-disconnected", { error: p.error?.message ?? null, at: new Date().toISOString() }));
  port.postMessage({ type: "heartbeat", at: new Date().toISOString() });
  setInterval(() => port.postMessage({ type: "heartbeat", at: new Date().toISOString() }), 60_000);

  const visible = await open("/bands.html", true);
  const hidden = await open("/bands.html", false);
  await step("Q1a-viewport", () => exec(hidden.id, "({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })"));
  await step("Q1a-capture-background-tab-scale1", async () => stats(await browser.tabs.captureTab(hidden.id, { format: "png", scale: 1 })));
  await step("Q1a-capture-visible-tab-scale1", async () => stats(await browser.tabs.captureTab(visible.id, { format: "png", scale: 1 })));
  await step("Q1b-capture-background-tab-scale0.5", async () => stats(await browser.tabs.captureTab(hidden.id, { format: "jpeg", quality: 75, scale: 0.5 })));
  await step("Q1c-rect-after-scroll-1000", async () => {
    await exec(hidden.id, "scrollTo(0, 1000)");
    await sleep(200);
    return stats(await browser.tabs.captureTab(hidden.id, { format: "png", rect: { x: 0, y: 0, width: 50, height: 50 }, scale: 1 }));
  });
  await step("Q1d-overlay-hidden-just-before-capture", async () => {
    await exec(hidden.id, "scrollTo(0, 0); document.getElementById('overlay').style.display = 'block'");
    await sleep(300);
    await exec(hidden.id, "document.getElementById('overlay').style.display = 'none'");
    return stats(await browser.tabs.captureTab(hidden.id, { format: "png", scale: 1 }));
  });
  await step("Q1e-capture-minimized-window", async () => {
    const win = await browser.windows.create({ url: `${BASE}/bands.html` });
    await sleep(1500);
    await browser.windows.update(win.id, { state: "minimized" });
    await sleep(1500);
    const result = await stats(await browser.tabs.captureTab(win.tabs[0].id, { format: "png", scale: 1 }));
    await browser.windows.remove(win.id);
    return result;
  });

  const typing = `(() => {
    const input = document.querySelector("#name");
    const fire = (type) => input.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: 5, clientY: 5, button: 0, buttons: type.endsWith("down") ? 1 : 0 }));
    fire("pointerdown"); fire("mousedown"); input.focus(); fire("pointerup"); fire("mouseup"); fire("click");
    const exec = [];
    for (const ch of "hi") {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      exec.push(document.execCommand("insertText", false, ch));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    }
    const input2 = document.querySelector("#name2");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input2, "xyz");
    input2.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.form.querySelector("button").click();
    return { execCommandResults: exec, focused: document.activeElement === input };
  })()`;
  const readState = "JSON.stringify(window.wrappedJSObject.__state)";
  for (const active of [false, true]) {
    const label = active ? "active" : "background";
    const tab = await open("/react.html", active);
    await step(`Q2-${label}-tab-synthetic-input`, async () => {
      const r = await exec(tab.id, typing);
      await sleep(300);
      return { ...r, state: JSON.parse(await exec(tab.id, readState)) };
    });
    await step(`Q2-${label}-tab-synthetic-link-click-navigates`, async () => {
      await exec(tab.id, "document.querySelector('#samepage').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))");
      await sleep(1500);
      return { url: (await browser.tabs.get(tab.id)).url };
    });
  }

  const csp = await open("/csp.html", false);
  await step("Q3a-window.eval-on-strict-CSP-page", () => exec(csp.id, "(() => { try { return { ok: true, value: window.eval('pageVar') }; } catch (e) { return { ok: false, error: String(e) }; } })()"));
  await step("Q3b-sandbox-raw-code-reads-page-var", () => exec(csp.id, "window.wrappedJSObject.pageVar"));
  await step("Q3c-event-based-page-program", async () => {
    const inner = `(async () => { const v = await (0, eval)("new Promise((r) => setTimeout(() => r(6 * 7), 50))"); document.dispatchEvent(new CustomEvent("__cf_spike", { detail: JSON.stringify({ ok: true, v }) })); })()`;
    return exec(hidden.id, `new Promise((resolve) => { document.addEventListener("__cf_spike", (e) => resolve(e.detail), { once: true }); window.eval(${JSON.stringify(inner)}); })`);
  });
  await step("Q3d-sandbox-raw-promise-result", () => exec(csp.id, "Promise.resolve(7)"));

  await step("Q5-tab-groups-in-MV2", async () => {
    const groupId = await browser.tabs.group({ tabIds: [hidden.id], createProperties: { windowId: hidden.windowId } });
    await browser.tabGroups.update(groupId, { title: "Claude · spik", color: "orange" });
    const members = await browser.tabs.query({ groupId });
    return { groupId, members: members.map((t) => t.id), group: await browser.tabGroups.get(groupId) };
  });
  await report("done", { at: new Date().toISOString() });
}

main();
```

- [ ] **Step 6: Run the spike**

Run both commands in the background, from `$SPIKE`:
```bash
node server.mjs
npx web-ext run --source-dir ext --firefox "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox" --pref browser.tabs.groups.enabled=true --no-input --no-reload
```
Wait until `$SPIKE/results.json` contains an entry named `done` (about 30 s).

- [ ] **Step 7: Check that the native port stays alive (Q4)**

Wait 11 minutes after `done`, then:
```bash
grep -c '"heartbeat"' "$SPIKE/host/host.log"; grep -c 'stdin closed' "$SPIKE/host/host.log"; grep -c Q4-native-disconnected "$SPIKE/results.json"
```
Expected: heartbeats ≥ 11, `0`, `0`.

- [ ] **Step 8: Stop and clean up**

Stop web-ext (Ctrl-C / kill its process) and the server. Then:
```bash
rm ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/cf_spike.json
```

- [ ] **Step 9: Compare against the expected results**

| Probe | Expected (later tasks assume this) | If different |
|---|---|---|
| Q1a background and visible tab, scale 1 | `width`/`height` equal `innerWidth`/`innerHeight`; `distinctColors` > 3; `topLeft` `0,0,0` | STOP |
| Q1b background tab, scale 0.5 | width ≈ `innerWidth / 2` | STOP |
| Q1c rect after scrolling 1000 px | `topLeft` `0,0,0` (rect is document-relative) | If `230,198,30`, rect is viewport-relative. In Task 13 drop `+ vp.scrollX` / `+ vp.scrollY` from the zoom rect and note it in Appendix A |
| Q1d overlay hidden right before capture | `topLeft` not `255,0,0` | STOP. `indicator.suspend` would need a paint wait |
| Q1e minimized window | Informational | Record it; README "Limitations" states the result |
| Q2 background and active tab input | `execCommandResults` `[true,true]`; `state.value` `"hi"`; `state.changes` ≥ 2; `state.value2` `"xyz"`; `state.submitted` 1; `state.keydowns` 2 | STOP |
| Q2 synthetic link click | url ends with `/landed.html` | STOP |
| Q3a | `ok: false` (blocked) | `ok: true` is also fine: the sandbox fallback simply never triggers |
| Q3b | `42` | STOP |
| Q3c | `'{"ok":true,"v":42}'` | STOP |
| Q3d | `7` | STOP |
| Q4 | Step 7 expectations | STOP |
| Q5 | integer `groupId`; `members` includes the tab | STOP |

STOP means: do not continue with Task 1. Report the observed values to the user, because the plan needs amending. Spec §10 says a broad Q2 failure reopens approach B (WebDriver BiDi).

- [ ] **Step 10: Record the results and commit**

Append to the spec:

```markdown
## Appendix A: Spike results (<date>, Firefox Developer Edition <version>)

| Probe | Observed |
|---|---|
| Q1a … | … |
```
Fill in one row per probe from `results.json` and Step 7.

```bash
git add docs/superpowers/specs/2026-10-17-claude-in-firefox-design.md
git commit -m "Record Firefox feasibility spike results"
```

---

### Task 1: Project scaffold and message framing

**Files:**
- Create: `package.json`, `host/src/framing.js`, `test/unit/framing.test.js`
- Modify: `.gitignore` (already ignores `node_modules/`, `host/bin/`, `web-ext-artifacts/`, so no change is expected)

**Interfaces:**
- Consumes: nothing
- Produces (`host/src/framing.js`):
  - `MAX_FRAME_BYTES = 67108864`, `FIREFOX_SPLIT_THRESHOLD = 900000`, `PART_CHARS = 250000`
  - `encode(msg: object): Buffer`, giving `[uint32 LE length][UTF-8 JSON]`
  - `class Decoder { push(chunk: Buffer): object[] }`, which throws `Frame too large: N bytes`
  - `onMessages(stream, handler: (msg) => void, onError?: (err) => void): void`
  - `splitForFirefox(msg: object, msgId: number): object[]`, returning `[msg]` or `[{type:"part", msgId, index, total, data}]`

- [ ] **Step 1: Create package.json and install dependencies**

`package.json`:
```json
{
  "name": "claude-in-firefox",
  "version": "0.1.0",
  "private": true,
  "description": "Drive Firefox from Claude Code through MCP tools modeled on Claude in Chrome",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/unit/*.test.js",
    "lint": "web-ext lint --source-dir extension",
    "build": "web-ext build --source-dir extension --overwrite-dest",
    "install-host": "node host/src/install.js",
    "e2e": "node --test --test-concurrency=1 test/e2e/*.test.js"
  }
}
```

```bash
npm install @modelcontextprotocol/sdk@^1
npm install --save-dev web-ext jsdom
```
Expected: `package.json` gains `dependencies` and `devDependencies`, and `package-lock.json` is created.

- [ ] **Step 2: Write the failing tests**

`test/unit/framing.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Decoder, FIREFOX_SPLIT_THRESHOLD, encode, onMessages, splitForFirefox } from "../../host/src/framing.js";

test("encode prefixes the UTF-8 body with its little-endian byte length", () => {
  const buf = encode({ a: "é" });
  assert.equal(buf.readUInt32LE(0), Buffer.byteLength('{"a":"é"}'));
  assert.equal(buf.subarray(4).toString("utf8"), '{"a":"é"}');
});

test("decoder handles messages split across chunks and several messages in one chunk", () => {
  const decoder = new Decoder();
  const both = Buffer.concat([encode({ n: 1 }), encode({ n: 2 })]);
  assert.deepEqual(decoder.push(both.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(both.subarray(3, 12)), [{ n: 1 }]);
  assert.deepEqual(decoder.push(both.subarray(12)), [{ n: 2 }]);
});

test("decoder rejects frames above the size limit", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
  assert.throws(() => new Decoder().push(header), /Frame too large/);
});

test("onMessages reports malformed frames through onError", async () => {
  const stream = new PassThrough();
  const errors = [];
  onMessages(stream, () => assert.fail("no message expected"), (err) => errors.push(err));
  const body = Buffer.from("{not json");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stream.write(Buffer.concat([header, body]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
});

test("small messages are not split", () => {
  const msg = { type: "call", args: { a: 1 } };
  assert.deepEqual(splitForFirefox(msg, 1), [msg]);
});

test("large messages split into parts under 1 MiB that survive the wire and reassemble exactly", () => {
  const msg = { type: "call", args: { blob: "x".repeat(FIREFOX_SPLIT_THRESHOLD) + 'é한👋"\\'.repeat(200_000) } };
  const parts = splitForFirefox(msg, 7);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.equal(part.type, "part");
    assert.equal(part.msgId, 7);
    assert.equal(part.total, parts.length);
    assert.ok(encode(part).length <= 1024 * 1024, `part ${part.index} is ${encode(part).length} bytes`);
  }
  const overTheWire = parts.map((p) => JSON.parse(JSON.stringify(p)).data).join("");
  assert.deepEqual(JSON.parse(overTheWire), msg);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/host/src/framing.js'`.

- [ ] **Step 4: Implement framing.js**

`host/src/framing.js`:
```js
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const FIREFOX_SPLIT_THRESHOLD = 900_000;
// Firefox rejects host→browser messages over 1 MiB. Re-serialized inside a part message,
// one UTF-16 code unit costs at most 3 bytes (a lone surrogate at a cut costs 6, at most twice per part).
export const PART_CHARS = 250_000;

// Firefox frames native messages in native byte order; every supported Mac is little-endian.
export function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class Decoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const messages = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) throw new Error(`Frame too large: ${length} bytes`);
      if (this.#buffer.length < 4 + length) break;
      messages.push(JSON.parse(this.#buffer.subarray(4, 4 + length).toString("utf8")));
      this.#buffer = this.#buffer.subarray(4 + length);
    }
    return messages;
  }
}

export function onMessages(stream, handler, onError = (err) => stream.destroy(err)) {
  const decoder = new Decoder();
  stream.on("data", (chunk) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (err) {
      onError(err);
      return;
    }
    for (const msg of messages) handler(msg);
  });
}

export function splitForFirefox(msg, msgId) {
  const json = JSON.stringify(msg);
  if (Buffer.byteLength(json, "utf8") <= FIREFOX_SPLIT_THRESHOLD) return [msg];
  const total = Math.ceil(json.length / PART_CHARS);
  const parts = [];
  for (let index = 0; index < total; index++) {
    parts.push({ type: "part", msgId, index, total, data: json.slice(index * PART_CHARS, (index + 1) * PART_CHARS) });
  }
  return parts;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json host/src/framing.js test/unit/framing.test.js
git commit -m "Add project scaffold and native-messaging framing codec"
```

---

### Task 2: Paths and the native host

**Files:**
- Create: `host/src/paths.js`, `host/src/native-host.js`, `test/unit/native-host.test.js`

**Interfaces:**
- Consumes: `encode`, `onMessages`, `splitForFirefox`, `Decoder`, `FIREFOX_SPLIT_THRESHOLD` from Task 1
- Produces:
  - `host/src/paths.js`:
    - constants `HOST_NAME = "claude_firefox_bridge"`, `EXTENSION_ID = "claude-firefox-bridge@local"`, `SOCKET_PATH`
    - `nativeManifestPath(homeDir?) → string`
    - `ensureSocketDir(dir) → Promise<void>`
    - `verifySocketDir(dir) → Promise<void>`, which throws on a missing directory (`ENOENT`), a symlink, the wrong owner or a loose mode
    - `isMain(importMetaUrl) → boolean`
  - `host/src/native-host.js`: `startNativeHost({ input, output, socketPath }) → Promise<{ close(): void }>`
- Wire protocol (spec §4):
  - client → host: `{type:"hello", sessionId}`, `{type:"call", id, sessionId, tool, args}`
  - host → Firefox: `{type:"call", id:"<clientId>:<id>", …}`, `{type:"session_closed", sessionId}`, `part` messages
  - Firefox → host: `{type:"result", id:"<clientId>:<id>", content, isError}`
  - host → client: the same result with the original numeric `id`

- [ ] **Step 1: Write the failing tests**

`test/unit/native-host.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Decoder, FIREFOX_SPLIT_THRESHOLD, encode } from "../../host/src/framing.js";
import { startNativeHost } from "../../host/src/native-host.js";

const tempSocketPath = () => path.join(fs.mkdtempSync("/tmp/cfb-test-"), "sock", "bridge.sock");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function messageQueue(stream) {
  const decoder = new Decoder();
  const queue = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    for (const msg of decoder.push(chunk)) {
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    }
  });
  return { next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve))) };
}

async function startHost() {
  const input = new PassThrough();
  const output = new PassThrough();
  const socketPath = tempSocketPath();
  const host = await startNativeHost({ input, output, socketPath });
  return { input, socketPath, host, fromHost: messageQueue(output) };
}

async function connectClient(socketPath) {
  const socket = net.connect(socketPath);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, messages: messageQueue(socket), send: (msg) => socket.write(encode(msg)) };
}

test("calls are forwarded with a client-prefixed id and results are routed back", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  const client = await connectClient(h.socketPath);
  client.send({ type: "hello", sessionId: "s1" });
  client.send({ type: "call", id: 5, sessionId: "s1", tool: "navigate", args: { url: "x" } });
  assert.deepEqual(await h.fromHost.next(), { type: "call", id: "1:5", sessionId: "s1", tool: "navigate", args: { url: "x" } });
  h.input.write(encode({ type: "result", id: "1:5", content: [{ type: "text", text: "ok" }], isError: false }));
  assert.deepEqual(await client.messages.next(), { type: "result", id: 5, content: [{ type: "text", text: "ok" }], isError: false });
  client.socket.destroy();
});

test("results go only to the client that made the call", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  const a = await connectClient(h.socketPath);
  const b = await connectClient(h.socketPath);
  a.send({ type: "call", id: 1, sessionId: "A", tool: "t", args: {} });
  b.send({ type: "call", id: 1, sessionId: "B", tool: "t", args: {} });
  const forwarded = [await h.fromHost.next(), await h.fromHost.next()];
  const forB = forwarded.find((m) => m.sessionId === "B");
  h.input.write(encode({ type: "result", id: forB.id, content: [], isError: false }));
  assert.equal((await b.messages.next()).id, 1);
  let aReceived = false;
  a.messages.next().then(() => { aReceived = true; });
  await sleep(50);
  assert.equal(aReceived, false);
  a.socket.destroy();
  b.socket.destroy();
});

test("a disconnecting client produces session_closed for its session", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  const client = await connectClient(h.socketPath);
  client.send({ type: "hello", sessionId: "s9" });
  await sleep(20);
  client.socket.destroy();
  assert.deepEqual(await h.fromHost.next(), { type: "session_closed", sessionId: "s9" });
});

test("calls larger than the Firefox limit arrive as parts", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  const client = await connectClient(h.socketPath);
  const args = { files: [{ base64: "A".repeat(FIREFOX_SPLIT_THRESHOLD * 2) }] };
  client.send({ type: "call", id: 1, sessionId: "s", tool: "file_upload", args });
  const first = await h.fromHost.next();
  assert.equal(first.type, "part");
  const parts = [first];
  while (parts.length < first.total) parts.push(await h.fromHost.next());
  assert.deepEqual(JSON.parse(parts.map((p) => p.data).join("")).args, args);
  client.socket.destroy();
});

test("the socket is private and a stale socket file is replaced", async (t) => {
  const socketPath = tempSocketPath();
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(socketPath, "");
  const host = await startNativeHost({ input: new PassThrough(), output: new PassThrough(), socketPath });
  t.after(() => host.close());
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
});

test("a second host refuses to start while the first is serving", async (t) => {
  const h = await startHost();
  t.after(() => h.host.close());
  await assert.rejects(startNativeHost({ input: new PassThrough(), output: new PassThrough(), socketPath: h.socketPath }), /already serving/);
});

test("Firefox closing stdin removes the socket", async () => {
  const h = await startHost();
  h.input.end();
  await sleep(20);
  assert.equal(fs.existsSync(h.socketPath), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/host/src/native-host.js'`.

- [ ] **Step 3: Implement paths.js**

`host/src/paths.js`:
```js
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "claude_firefox_bridge";
export const EXTENSION_ID = "claude-firefox-bridge@local";
// Fixed under /tmp rather than $TMPDIR: Firefox and Claude Code start the two ends with different environments.
export const SOCKET_PATH = `/tmp/claude-firefox-bridge-${os.userInfo().uid}/bridge.sock`;

export function nativeManifestPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library/Application Support/Mozilla/NativeMessagingHosts", `${HOST_NAME}.json`);
}

export async function ensureSocketDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fsp.lstat(dir);
  if (st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid()) await fsp.chmod(dir, 0o700);
  await verifySocketDir(dir);
}

export async function verifySocketDir(dir) {
  const st = await fsp.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} is owned by another user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} must not be accessible to other users (mode ${(st.mode & 0o777).toString(8)})`);
}

export function isMain(importMetaUrl) {
  return process.argv[1] != null && fs.realpathSync(process.argv[1]) === fileURLToPath(importMetaUrl);
}
```

- [ ] **Step 4: Implement native-host.js**

`host/src/native-host.js`:
```js
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { encode, onMessages, splitForFirefox } from "./framing.js";
import { SOCKET_PATH, ensureSocketDir, isMain } from "./paths.js";

export async function startNativeHost({ input, output, socketPath }) {
  await ensureSocketDir(path.dirname(socketPath));
  await claimSocketPath(socketPath);

  const clients = new Map();
  let nextClientId = 1;
  let nextMsgId = 1;
  const toFirefox = (msg) => {
    for (const part of splitForFirefox(msg, nextMsgId++)) output.write(encode(part));
  };

  const server = net.createServer((socket) => {
    const clientId = nextClientId++;
    const client = { socket, sessionId: null };
    clients.set(clientId, client);
    onMessages(socket, (msg) => {
      if (msg.type === "hello") client.sessionId = msg.sessionId;
      else if (msg.type === "call") toFirefox({ type: "call", id: `${clientId}:${msg.id}`, sessionId: msg.sessionId, tool: msg.tool, args: msg.args });
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clients.delete(clientId);
      if (client.sessionId) toFirefox({ type: "session_closed", sessionId: client.sessionId });
    });
  });

  onMessages(
    input,
    (msg) => {
      if (msg.type !== "result" || typeof msg.id !== "string") return;
      const sep = msg.id.indexOf(":");
      clients.get(Number(msg.id.slice(0, sep)))?.socket.write(encode({ ...msg, id: Number(msg.id.slice(sep + 1)) }));
    },
    (err) => process.stderr.write(`claude-firefox native host: bad message from Firefox: ${err.message}\n`),
  );

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await fsp.chmod(socketPath, 0o600);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    for (const { socket } of clients.values()) socket.destroy();
    fs.rmSync(socketPath, { force: true });
  };
  input.on("end", close);
  return { close };
}

async function claimSocketPath(socketPath) {
  if (!fs.existsSync(socketPath)) return;
  const live = await new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
  if (live) throw new Error(`Another native host is already serving ${socketPath}`);
  await fsp.rm(socketPath, { force: true });
}

if (isMain(import.meta.url)) {
  try {
    const host = await startNativeHost({ input: process.stdin, output: process.stdout, socketPath: SOCKET_PATH });
    process.stdin.on("end", () => process.exit(0));
    process.on("SIGTERM", () => { host.close(); process.exit(0); });
  } catch (err) {
    process.stderr.write(`claude-firefox native host: ${err.message}\n`);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
git add host/src/paths.js host/src/native-host.js test/unit/native-host.test.js
git commit -m "Add native host bridging Firefox stdio to a private unix socket"
```

---
### Task 3: MCP tool definitions and the MCP server

**Files:**
- Create: `host/src/tools.js`, `host/src/mcp-server.js`, `test/unit/mcp-server.test.js`

**Interfaces:**
- Consumes: `encode`, `onMessages` (Task 1); `SOCKET_PATH`, `isMain`, `verifySocketDir` (Task 2)
- Produces:
  - `host/src/tools.js`: `TOOLS: Array<{name, description, inputSchema}>` (15 tools); `TOOL_BY_NAME: Map<string, tool>`
  - `host/src/mcp-server.js`:
    - constants `CALL_TIMEOUT_MS = 30000`, `BATCH_TIMEOUT_MS = 90000`, `MAX_UPLOAD_BYTES = 10485760`, `NOT_CONNECTED_MESSAGE`
    - `class BridgeClient { constructor({ socketPath, sessionId }); sessionId; call(tool, args, timeoutMs) → Promise<{content, isError}>; close() }`
    - `callTool(bridge, name, args, timeoutMs?) → Promise<{content, isError?}>`, which throws on an unknown tool or missing required args
    - `createMcpServer({ bridge }) → Server`
  - `file_upload` arguments sent to Firefox: `{ ref, tabId, files: [{ name, mimeType, base64 }] }`, where `paths` has been replaced by `files`

- [ ] **Step 1: Write tools.js (data only, tested in Step 2)**

`host/src/tools.js`:
```js
const tabId = { type: "integer", description: "ID of a tab in this session's tab group (see tabs_context)." };
const point = (description) => ({ type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description });

export const TOOLS = [
  {
    name: "tabs_context",
    description: "List the tabs in this session's Firefox tab group. Call this first in every conversation to learn which tab IDs you may use. Each Claude Code session gets its own group, and tabs outside it cannot be controlled. Pass createIfEmpty: true to create the group (with one blank tab) when this session has none yet.",
    inputSchema: { type: "object", properties: { createIfEmpty: { type: "boolean", description: "Create the tab group with a blank tab if this session has none yet." } } },
  },
  {
    name: "tabs_create",
    description: "Open a new blank tab in this session's tab group and return its tab ID. Prefer a fresh tab per task over reusing tabs the user is looking at.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tabs_close",
    description: "Close a tab in this session's tab group.",
    inputSchema: { type: "object", properties: { tabId }, required: ["tabId"] },
  },
  {
    name: "navigate",
    description: 'Load a URL in a tab, or go "back" / "forward" in its history. Waits up to 15 seconds for the page to finish loading and returns the final URL and title. URLs without a scheme get https://.',
    inputSchema: { type: "object", properties: { url: { type: "string", description: 'URL to load, or "back" / "forward".' }, tabId }, required: ["url", "tabId"] },
  },
  {
    name: "computer",
    description: [
      "Use the mouse and keyboard in a tab and take screenshots. Input is synthesized inside the page (Firefox gives extensions no OS-level input): CSS :hover styles do not apply, native <select> popups and file pickers cannot be opened (use form_input / file_upload), and a page that ignores script-generated events will not react.",
      "* Take a screenshot before clicking by coordinate; coordinates are pixels in the most recent screenshot of that tab.",
      "* Prefer ref targets from read_page or find over coordinates when you have them.",
      "* Click the center of elements.",
      '* key takes space-separated keys or chords, e.g. "Enter", "Tab", "shift+Tab", "cmd+a", "Page_Down". Use "cmd" on macOS.',
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["left_click", "right_click", "double_click", "triple_click", "type", "key", "screenshot", "wait", "scroll", "scroll_to", "hover", "left_click_drag", "zoom"],
          description: [
            "left_click / right_click / double_click / triple_click: click at coordinate or ref.",
            "type: type text into the focused element.",
            "key: press keys or chords given in text.",
            "screenshot: capture the visible part of the page.",
            "wait: pause for duration seconds.",
            "scroll: scroll at coordinate (or ref) in scroll_direction by scroll_amount ticks; returns a screenshot.",
            "scroll_to: scroll the element with ref into view.",
            "hover: move the pointer to coordinate or ref without clicking.",
            "left_click_drag: drag from start_coordinate to coordinate.",
            "zoom: capture region at higher resolution for close inspection.",
          ].join("\n"),
        },
        coordinate: point("[x, y] in screenshot pixels: the click, hover or scroll target, or the end point of left_click_drag."),
        start_coordinate: point("[x, y] start point for left_click_drag."),
        ref: { type: "string", description: 'Element ref from read_page or find (e.g. "ref_12"). Alternative to coordinate for clicks, hover and scroll; required for scroll_to.' },
        text: { type: "string", description: "Text to type (type) or keys to press (key)." },
        modifiers: { type: "string", description: 'Modifier keys held during a click, joined with "+": ctrl, shift, alt, cmd.' },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "integer", minimum: 1, maximum: 10, description: "Scroll wheel ticks of 100 px. Default 3." },
        duration: { type: "number", minimum: 0, maximum: 10, description: "Seconds to wait (wait action)." },
        region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[x0, y0, x1, y1] in screenshot pixels (zoom action)." },
        repeat: { type: "integer", minimum: 1, maximum: 100, description: "Repeat the key sequence this many times (key action). Default 1." },
        scale: { type: "number", minimum: 0.1, maximum: 1, description: "Shrink the returned screenshot or zoom image by this factor to save tokens. Coordinates always refer to the full-size frame reported with the image." },
        tabId,
      },
      required: ["action", "tabId"],
    },
  },
  {
    name: "read_page",
    description: 'Return an accessibility-tree outline of the page. Each element gets a stable ref (e.g. ref_12) usable with computer, form_input and file_upload. filter "interactive" lists only visible on-screen controls; the default "all" also includes off-screen and hidden content. Output is limited to max_chars (default 50000) and truncated at a line boundary with a note; narrow it with depth or ref_id. Password and payment field values are redacted. Cross-origin iframe contents are included with refs like f7_ref_3.',
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        filter: { type: "string", enum: ["interactive", "all"] },
        depth: { type: "integer", minimum: 1, description: "Maximum tree depth (default 15)." },
        ref_id: { type: "string", description: "Only return this element and its descendants." },
        max_chars: { type: "integer", minimum: 100, description: "Maximum output characters (default 50000)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "find",
    description: 'Find elements whose text, label, role or attributes match keywords in the query (keyword scoring, not semantic search). Returns up to 20 refs, best match first. Use words that appear on the page, e.g. "search box" or "add to cart button".',
    inputSchema: { type: "object", properties: { query: { type: "string" }, tabId }, required: ["query", "tabId"] },
  },
  {
    name: "form_input",
    description: "Set a form control by ref: text inputs and textareas (string), selects (option value or visible text), checkboxes (boolean), radio buttons (any value selects it), date/number/range inputs, and contenteditable elements. Fires input and change events so frameworks such as React notice the change.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, value: { type: ["string", "boolean", "number"] }, tabId }, required: ["ref", "value", "tabId"] },
  },
  {
    name: "get_page_text",
    description: "Return the page's readable text, preferring the main article or content element. Good for reading long pages without screenshots. Limited to max_chars (default 50000) with a truncation note.",
    inputSchema: { type: "object", properties: { tabId, max_chars: { type: "integer", minimum: 100 } }, required: ["tabId"] },
  },
  {
    name: "javascript_tool",
    description: "Run JavaScript in the page and return the value of the last expression (REPL style; promises are awaited). Code that uses top-level await or return is retried wrapped in an async function, so use return there to produce a value. If the page's Content Security Policy forbids eval, the code runs in the extension's isolated sandbox instead: page globals are then reachable through window.wrappedJSObject and the result must be JSON-serializable.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["javascript_exec"] }, text: { type: "string", description: "JavaScript source." }, tabId }, required: ["action", "text", "tabId"] },
  },
  {
    name: "read_console_messages",
    description: "Read console output (log/info/warn/error/debug, uncaught errors, unhandled rejections) captured from the tab since its current origin loaded. Provide a pattern to keep the output focused.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        onlyErrors: { type: "boolean", description: "Only errors and uncaught exceptions." },
        clear: { type: "boolean", description: "Clear the buffer after reading." },
        pattern: { type: "string", description: "Case-insensitive regular expression filter." },
        limit: { type: "integer", minimum: 1, description: "Maximum messages, most recent first kept (default 100)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "read_network_requests",
    description: "List HTTP requests made by the tab since its current origin loaded (method, URL, status). The buffer resets when the tab navigates to a different origin.",
    inputSchema: {
      type: "object",
      properties: {
        tabId,
        urlPattern: { type: "string", description: "Only requests whose URL contains this substring." },
        clear: { type: "boolean", description: "Clear the buffer after reading." },
        limit: { type: "integer", minimum: 1, description: "Maximum requests, most recent kept (default 100)." },
      },
      required: ["tabId"],
    },
  },
  {
    name: "resize_window",
    description: "Resize the Firefox window that contains the tab.",
    inputSchema: { type: "object", properties: { width: { type: "integer", minimum: 100, maximum: 7680 }, height: { type: "integer", minimum: 100, maximum: 4320 }, tabId }, required: ["width", "height", "tabId"] },
  },
  {
    name: "file_upload",
    description: 'Put local files into an <input type="file"> identified by ref, as if the user had picked them. Do not click file inputs: the native file picker cannot be operated. Paths are read by the MCP server (relative paths resolve against its working directory); total size up to 10 MB.',
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, minItems: 1 }, ref: { type: "string" }, tabId }, required: ["paths", "ref", "tabId"] },
  },
  {
    name: "browser_batch",
    description: "Run several browser tool calls in order in one round trip, stopping at the first error. Use it whenever you can predict the next steps, e.g. click → type → key Enter → screenshot. Coordinates refer to the latest screenshot of the tab, including one taken earlier in the same batch.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name", "input"] },
        },
      },
      required: ["actions"],
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
```

- [ ] **Step 2: Write the failing tests**

`test/unit/mcp-server.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { encode, onMessages } from "../../host/src/framing.js";
import { BridgeClient, NOT_CONNECTED_MESSAGE, callTool } from "../../host/src/mcp-server.js";
import { TOOLS } from "../../host/src/tools.js";

const ok = (text) => ({ content: [{ type: "text", text }], isError: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeBridge(handler) {
  const calls = [];
  return { calls, call: async (tool, args, timeoutMs) => { calls.push({ tool, args, timeoutMs }); return handler(tool, args); } };
}

test("the 15 tools have unique names and object input schemas", () => {
  assert.equal(TOOLS.length, 15);
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, 15);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.type, "object", tool.name);
});

test("unknown tools and missing required arguments never reach Firefox", async () => {
  const bridge = fakeBridge(() => ok("unexpected"));
  await assert.rejects(callTool(bridge, "teleport", {}), /Unknown tool: teleport/);
  await assert.rejects(callTool(bridge, "navigate", { tabId: 1 }), /missing required argument\(s\): url/);
  assert.equal(bridge.calls.length, 0);
});

test("ordinary tools are forwarded with the 30 s timeout", async () => {
  const bridge = fakeBridge(() => ok("done"));
  assert.deepEqual(await callTool(bridge, "tabs_create", {}), ok("done"));
  assert.deepEqual(bridge.calls, [{ tool: "tabs_create", args: {}, timeoutMs: 30_000 }]);
});

test("browser_batch runs actions in order, prefixes text and passes images through", async () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/jpeg" };
  const bridge = fakeBridge((tool) => (tool === "computer" ? { content: [{ type: "text", text: "shot" }, image], isError: false } : ok(`ran ${tool}`)));
  const result = await callTool(bridge, "browser_batch", { actions: [{ name: "navigate", input: { tabId: 1, url: "x" } }, { name: "computer", input: { tabId: 1, action: "screenshot" } }] });
  assert.deepEqual(bridge.calls.map((c) => c.tool), ["navigate", "computer"]);
  assert.deepEqual(result.content, [{ type: "text", text: "[0:navigate] ran navigate" }, { type: "text", text: "[1:computer] shot" }, image]);
  assert.equal(result.isError, undefined);
});

test("browser_batch stops at the first error", async () => {
  const bridge = fakeBridge((tool) => (tool === "find" ? { content: [{ type: "text", text: "boom" }], isError: true } : ok("fine")));
  const result = await callTool(bridge, "browser_batch", {
    actions: [{ name: "find", input: { tabId: 1, query: "q" } }, { name: "tabs_create", input: {} }],
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: "[0:find] boom" }]);
  assert.deepEqual(bridge.calls.map((c) => c.tool), ["find"]);
});

test("browser_batch rejects nesting and bad action lists", async () => {
  const bridge = fakeBridge(() => ok("fine"));
  const nested = await callTool(bridge, "browser_batch", { actions: [{ name: "browser_batch", input: { actions: [] } }] });
  assert.equal(nested.isError, true);
  assert.match(nested.content[0].text, /cannot be nested/);
  await assert.rejects(callTool(bridge, "browser_batch", { actions: [] }), /1-50/);
});

test("file_upload reads files into base64 with names and mime types", async () => {
  const dir = fs.mkdtempSync("/tmp/cfb-upload-");
  fs.writeFileSync(path.join(dir, "note.txt"), "hello");
  const bridge = fakeBridge(() => ok("uploaded"));
  await callTool(bridge, "file_upload", { tabId: 1, ref: "ref_1", paths: [path.join(dir, "note.txt")] });
  assert.deepEqual(bridge.calls[0].args, { tabId: 1, ref: "ref_1", files: [{ name: "note.txt", mimeType: "text/plain", base64: Buffer.from("hello").toString("base64") }] });
});

test("file_upload rejects directories and totals over 10 MB", async () => {
  const dir = fs.mkdtempSync("/tmp/cfb-upload-");
  const big = path.join(dir, "big.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 10 * 1024 * 1024 + 1);
  const bridge = fakeBridge(() => ok("uploaded"));
  await assert.rejects(callTool(bridge, "file_upload", { tabId: 1, ref: "ref_1", paths: [dir] }), /is not a regular file/);
  await assert.rejects(callTool(bridge, "file_upload", { tabId: 1, ref: "ref_1", paths: [big] }), /exceeds 10 MB/);
  assert.equal(bridge.calls.length, 0);
});

async function fakeHost(socketPath, onCall) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    onMessages(socket, (msg) => {
      received.push(msg);
      if (msg.type === "call") onCall(msg, (reply) => socket.write(encode(reply)));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { received, close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }) };
}

test("BridgeClient reports not connected when no host is listening", async () => {
  const dir = fs.mkdtempSync("/tmp/cfb-mcp-");
  const client = new BridgeClient({ socketPath: path.join(dir, "bridge.sock"), sessionId: "s" });
  await assert.rejects(client.call("tabs_create", {}, 1000), { message: NOT_CONNECTED_MESSAGE });
  const missing = new BridgeClient({ socketPath: "/tmp/cfb-does-not-exist/bridge.sock", sessionId: "s" });
  await assert.rejects(missing.call("tabs_create", {}, 1000), { message: NOT_CONNECTED_MESSAGE });
});

test("BridgeClient sends hello once and resolves results by id", async (t) => {
  const socketPath = path.join(fs.mkdtempSync("/tmp/cfb-mcp-"), "bridge.sock");
  const host = await fakeHost(socketPath, (msg, reply) => reply({ type: "result", id: msg.id, content: [{ type: "text", text: `${msg.tool} ok` }], isError: false }));
  const client = new BridgeClient({ socketPath, sessionId: "s1" });
  t.after(async () => { client.close(); await host.close(); });
  const [a, b] = await Promise.all([client.call("tabs_create", {}, 1000), client.call("tabs_context", {}, 1000)]);
  assert.equal(a.content[0].text, "tabs_create ok");
  assert.equal(b.content[0].text, "tabs_context ok");
  assert.deepEqual(host.received.filter((m) => m.type === "hello"), [{ type: "hello", sessionId: "s1" }]);
  assert.equal(host.received.filter((m) => m.type === "call").every((m) => m.sessionId === "s1"), true);
});

test("BridgeClient times out slow calls", async (t) => {
  const socketPath = path.join(fs.mkdtempSync("/tmp/cfb-mcp-"), "bridge.sock");
  const host = await fakeHost(socketPath, () => {});
  const client = new BridgeClient({ socketPath, sessionId: "s" });
  t.after(async () => { client.close(); await host.close(); });
  await assert.rejects(client.call("navigate", {}, 50), /navigate timed out/);
});

test("BridgeClient fails pending calls when the host goes away and reconnects on the next call", async (t) => {
  const socketPath = path.join(fs.mkdtempSync("/tmp/cfb-mcp-"), "bridge.sock");
  const first = await fakeHost(socketPath, () => {});
  const client = new BridgeClient({ socketPath, sessionId: "s" });
  const pending = client.call("navigate", {}, 5000);
  await sleep(50);
  await first.close();
  await assert.rejects(pending, /Connection to Firefox lost/);
  fs.rmSync(socketPath, { force: true });
  const second = await fakeHost(socketPath, (msg, reply) => reply({ type: "result", id: msg.id, content: [], isError: false }));
  t.after(async () => { client.close(); await second.close(); });
  assert.deepEqual(await client.call("tabs_create", {}, 1000), { content: [], isError: false });
  assert.equal(second.received[0].type, "hello");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/host/src/mcp-server.js'`.

- [ ] **Step 4: Implement mcp-server.js**

`host/src/mcp-server.js`:
```js
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { encode, onMessages } from "./framing.js";
import { SOCKET_PATH, isMain, verifySocketDir } from "./paths.js";
import { TOOLS, TOOL_BY_NAME } from "./tools.js";

export const CALL_TIMEOUT_MS = 30_000;
export const BATCH_TIMEOUT_MS = 90_000;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const NOT_CONNECTED_MESSAGE = "Firefox extension not connected — is Firefox Developer Edition running with the Claude in Firefox extension installed?";

const MIME_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".html": "text/html", ".zip": "application/zip",
};

export class BridgeClient {
  #socketPath;
  #socket = null;
  #connecting = null;
  #pending = new Map();
  #nextId = 1;

  constructor({ socketPath, sessionId }) {
    this.#socketPath = socketPath;
    this.sessionId = sessionId;
  }

  async call(tool, args, timeoutMs) {
    const socket = await this.#connect();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${tool} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      socket.write(encode({ type: "call", id, sessionId: this.sessionId, tool, args }));
    });
  }

  close() {
    this.#socket?.destroy();
  }

  #connect() {
    if (this.#socket) return Promise.resolve(this.#socket);
    this.#connecting ??= this.#open().finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async #open() {
    try {
      await verifySocketDir(path.dirname(this.#socketPath));
    } catch (err) {
      throw new Error(err.code === "ENOENT" ? NOT_CONNECTED_MESSAGE : err.message);
    }
    const socket = net.connect(this.#socketPath);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", () => reject(new Error(NOT_CONNECTED_MESSAGE)));
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.#socket === socket) this.#socket = null;
      for (const pending of this.#pending.values()) pending.reject(new Error("Connection to Firefox lost"));
      this.#pending.clear();
    });
    onMessages(socket, (msg) => {
      if (msg.type !== "result") return;
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      pending.resolve({ content: msg.content, isError: !!msg.isError });
    });
    socket.write(encode({ type: "hello", sessionId: this.sessionId }));
    this.#socket = socket;
    return socket;
  }
}

export async function callTool(bridge, name, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined);
  if (missing.length) throw new Error(`${name}: missing required argument(s): ${missing.join(", ")}`);
  if (name === "browser_batch") return runBatch(bridge, args.actions);
  if (name === "file_upload") return bridge.call(name, await withFileContents(args), timeoutMs);
  return bridge.call(name, args, timeoutMs);
}

async function runBatch(bridge, actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 50) throw new Error("browser_batch: actions must contain 1-50 {name, input} items");
  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  const content = [];
  for (const [index, action] of actions.entries()) {
    const name = action?.name;
    let result;
    try {
      if (name === "browser_batch") throw new Error("browser_batch cannot be nested");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("browser_batch timed out after 90s");
      result = await callTool(bridge, name, action.input ?? {}, Math.min(CALL_TIMEOUT_MS, remaining));
    } catch (err) {
      result = { content: [{ type: "text", text: err.message }], isError: true };
    }
    for (const block of result.content) content.push(block.type === "text" ? { ...block, text: `[${index}:${name}] ${block.text}` } : block);
    if (result.isError) return { content, isError: true };
  }
  return { content };
}

async function withFileContents({ paths, ...rest }) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("file_upload: paths must be a non-empty array");
  const files = [];
  let total = 0;
  for (const p of paths) {
    const resolved = path.resolve(p);
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error(`file_upload: ${resolved} is not a regular file`);
    total += stat.size;
    if (total > MAX_UPLOAD_BYTES) throw new Error("file_upload: total size exceeds 10 MB");
    files.push({
      name: path.basename(resolved),
      mimeType: MIME_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
      base64: (await fsp.readFile(resolved)).toString("base64"),
    });
  }
  return { ...rest, files };
}

export function createMcpServer({ bridge }) {
  const server = new Server({ name: "claude-in-firefox", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      return await callTool(bridge, params.name, params.arguments ?? {});
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  });
  return server;
}

if (isMain(import.meta.url)) {
  const bridge = new BridgeClient({ socketPath: SOCKET_PATH, sessionId: randomUUID() });
  await createMcpServer({ bridge }).connect(new StdioServerTransport());
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (25 tests).

- [ ] **Step 6: Smoke-check the stdio server**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node host/src/mcp-server.js | head -c 400
```
Expected: two JSON-RPC responses. The second lists tools starting with `"name":"tabs_context"`.

- [ ] **Step 7: Commit**

```bash
git add host/src/tools.js host/src/mcp-server.js test/unit/mcp-server.test.js
git commit -m "Add MCP server with tool schemas, socket client, batching and file reading"
```

---

### Task 4: Installer

**Files:**
- Create: `host/src/install.js`, `test/unit/install.test.js`

**Interfaces:**
- Consumes: `EXTENSION_ID`, `HOST_NAME`, `isMain`, `nativeManifestPath` (Task 2)
- Produces: `install({ homeDir?, repoDir?, nodePath? }) → { manifestPath, wrapperPath, mcpCommand }`; `npm run install-host` prints the three values

- [ ] **Step 1: Write the failing test**

`test/unit/install.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { install } from "../../host/src/install.js";

test("install writes the native manifest, an executable wrapper and the claude mcp add command", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-repo-"));
  const result = install({ homeDir: home, repoDir: repo, nodePath: "/opt/node/bin/node" });

  assert.equal(result.manifestPath, path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")), {
    name: "claude_firefox_bridge",
    description: "Claude in Firefox bridge",
    path: path.join(repo, "host/bin/native-host"),
    type: "stdio",
    allowed_extensions: ["claude-firefox-bridge@local"],
  });
  assert.equal(fs.readFileSync(result.wrapperPath, "utf8"), `#!/bin/sh\nexec "/opt/node/bin/node" "${path.join(repo, "host/src/native-host.js")}" "$@"\n`);
  assert.equal(fs.statSync(result.wrapperPath).mode & 0o111, 0o111);
  assert.equal(result.mcpCommand, `claude mcp add --scope user firefox -- "/opt/node/bin/node" "${path.join(repo, "host/src/mcp-server.js")}"`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/host/src/install.js'`.

- [ ] **Step 3: Implement install.js**

`host/src/install.js`:
```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, HOST_NAME, isMain, nativeManifestPath } from "./paths.js";

const REPO_DIR = fileURLToPath(new URL("../../", import.meta.url));

export function install({ homeDir = os.homedir(), repoDir = REPO_DIR, nodePath = process.execPath } = {}) {
  // Firefox starts native hosts with a minimal PATH, so the wrapper pins the absolute node binary.
  const wrapperPath = path.join(repoDir, "host/bin/native-host");
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${nodePath}" "${path.join(repoDir, "host/src/native-host.js")}" "$@"\n`);
  fs.chmodSync(wrapperPath, 0o755);

  const manifestPath = nativeManifestPath(homeDir);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = { name: HOST_NAME, description: "Claude in Firefox bridge", path: wrapperPath, type: "stdio", allowed_extensions: [EXTENSION_ID] };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifestPath,
    wrapperPath,
    mcpCommand: `claude mcp add --scope user firefox -- "${nodePath}" "${path.join(repoDir, "host/src/mcp-server.js")}"`,
  };
}

if (isMain(import.meta.url)) {
  const { manifestPath, wrapperPath, mcpCommand } = install();
  console.log(`Native messaging manifest: ${manifestPath}`);
  console.log(`Native host wrapper:       ${wrapperPath}`);
  console.log(`\nRegister the MCP server with Claude Code:\n  ${mcpCommand}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (26 tests).

- [ ] **Step 5: Commit**

```bash
git add host/src/install.js test/unit/install.test.js
git commit -m "Add installer for the native-messaging manifest and host wrapper"
```

---
### Task 5: Background core (reassembly, dispatcher, sessions)

**Files:**
- Create: `extension/background/reassemble.js`, `extension/background/dispatch.js`, `extension/background/sessions.js`
- Test: `test/unit/reassemble.test.js`, `test/unit/dispatch.test.js`, `test/unit/sessions.test.js`

**Interfaces:**
- Consumes: the wire shapes from Task 2 (`call`, `session_closed`, `part`, `result`)
- Produces:
  - `createReassembler({ now?, maxAgeMs? }) → { push(part) → object | null }`
  - `createDispatcher({ tools, sessions, activity, send }) → async (msg) => void`
    - `tools[name] = { tabScoped, run(ctx) }`
    - `sessions` is used only for `ownedTab(sessionId, tabId)` and `close(sessionId)`
    - `activity = { start(tabId), end(tabId) }`
    - `send(resultMsg)`
  - `createSessions(api)` → `{ context(sessionId, { createIfEmpty }) → {availableTabs, tabGroupId} | null, createTab(sessionId) → tab, ownedTab(sessionId, tabId) → tab, adoptOpened(tab), close(sessionId) }`
  - `NO_GROUP_MESSAGE` (exported from `sessions.js`)

- [ ] **Step 1: Write the failing tests**

`test/unit/reassemble.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { createReassembler } from "../../extension/background/reassemble.js";

const partsOf = (msg, msgId, size) => {
  const json = JSON.stringify(msg);
  const total = Math.ceil(json.length / size);
  return Array.from({ length: total }, (_, index) => ({ type: "part", msgId, index, total, data: json.slice(index * size, (index + 1) * size) }));
};

test("parts arriving out of order reassemble into the original message", () => {
  const msg = { type: "call", id: "1:1", args: { text: "héllo 👋".repeat(50) } };
  const reassembler = createReassembler();
  const results = partsOf(msg, 3, 17).reverse().map((part) => reassembler.push(part));
  assert.deepEqual(results.filter(Boolean), [msg]);
  assert.deepEqual(results.at(-1), msg);
});

test("duplicate parts are ignored and incomplete messages return null", () => {
  const parts = partsOf({ a: "x".repeat(100) }, 1, 40);
  const reassembler = createReassembler();
  assert.equal(reassembler.push(parts[0]), null);
  assert.equal(reassembler.push(parts[0]), null);
  assert.equal(reassembler.push(parts[1]), null);
  assert.deepEqual(reassembler.push(parts[2]), { a: "x".repeat(100) });
});

test("parts older than the max age are discarded", () => {
  let now = 0;
  const reassembler = createReassembler({ now: () => now, maxAgeMs: 60_000 });
  const parts = partsOf({ a: "x".repeat(100) }, 1, 40);
  reassembler.push(parts[0]);
  now = 61_000;
  for (const part of parts.slice(1)) assert.equal(reassembler.push(part), null);
});
```

`test/unit/dispatch.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { createDispatcher } from "../../extension/background/dispatch.js";

function setup(tools, ownedTab = async (_sessionId, tabId) => ({ id: tabId, url: "https://example.test/" })) {
  const sent = [];
  const closed = [];
  const events = [];
  const activity = { start: (id) => events.push(["start", id]), end: (id) => events.push(["end", id]) };
  const sessions = { ownedTab, close: (id) => closed.push(id) };
  return { dispatch: createDispatcher({ tools, sessions, activity, send: (m) => sent.push(m) }), sent, closed, events };
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
  const { dispatch, sent, events } = setup({ look: { tabScoped: true, run: async () => "ok" } }, async () => { throw new Error("Tab 9 is not in this session's tab group. Valid tab IDs: 5"); });
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
```

`test/unit/sessions.test.js`:
```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/extension/background/reassemble.js'` (and likewise for dispatch.js and sessions.js).

- [ ] **Step 3: Implement reassemble.js**

`extension/background/reassemble.js`:
```js
export function createReassembler({ now = () => Date.now(), maxAgeMs = 60_000 } = {}) {
  const pending = new Map();
  return {
    push(part) {
      for (const [id, entry] of pending) if (now() - entry.startedAt > maxAgeMs) pending.delete(id);
      let entry = pending.get(part.msgId);
      if (!entry) {
        entry = { chunks: new Array(part.total), received: 0, startedAt: now() };
        pending.set(part.msgId, entry);
      }
      if (entry.chunks[part.index] === undefined) {
        entry.chunks[part.index] = part.data;
        entry.received++;
      }
      if (entry.received < part.total) return null;
      pending.delete(part.msgId);
      return JSON.parse(entry.chunks.join(""));
    },
  };
}
```

- [ ] **Step 4: Implement dispatch.js**

`extension/background/dispatch.js`:
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
      activity.start(tab.id);
      try {
        return await def.run({ sessionId, args: { ...args, tabId }, tab });
      } finally {
        activity.end(tab.id);
      }
    });
  }

  return async function dispatch(msg) {
    if (msg.type === "session_closed") {
      sessions.close(msg.sessionId);
      return;
    }
    if (msg.type !== "call") return;
    let reply;
    try {
      reply = { content: toContent(await execute(msg)), isError: false };
    } catch (err) {
      reply = { content: [{ type: "text", text: err?.message || String(err) }], isError: true };
    }
    send({ type: "result", id: msg.id, ...reply });
  };
}

function toContent(value) {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (Array.isArray(value)) return value;
  throw new Error("Tool returned an unsupported result");
}
```

- [ ] **Step 5: Implement sessions.js**

`extension/background/sessions.js`:
```js
const COLORS = ["orange", "blue", "green", "purple", "cyan", "pink", "yellow", "red"];
export const NO_GROUP_MESSAGE = "This session has no tab group yet. Call tabs_context with createIfEmpty: true first.";

export function createSessions(api) {
  const groups = new Map();
  let nextColor = 0;

  async function liveGroup(sessionId) {
    const groupId = groups.get(sessionId);
    if (groupId == null) return null;
    try {
      await api.tabGroups.get(groupId);
      return groupId;
    } catch {
      groups.delete(sessionId);
      return null;
    }
  }

  async function newBlankTab() {
    let win = null;
    try {
      win = await api.windows.getLastFocused({ windowTypes: ["normal"] });
    } catch {
      // No normal window is open (possible on macOS); a new one is created below.
    }
    if (win) return api.tabs.create({ windowId: win.id, url: "about:blank", active: false });
    const created = await api.windows.create({ url: "about:blank" });
    return created.tabs[0];
  }

  return {
    async context(sessionId, { createIfEmpty = false } = {}) {
      let groupId = await liveGroup(sessionId);
      if (groupId == null) {
        if (!createIfEmpty) return null;
        const tab = await newBlankTab();
        groupId = await api.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
        await api.tabGroups.update(groupId, { title: `Claude · ${sessionId.slice(0, 4)}`, color: COLORS[nextColor++ % COLORS.length] });
        groups.set(sessionId, groupId);
      }
      const tabs = await api.tabs.query({ groupId });
      return { availableTabs: tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url })), tabGroupId: groupId };
    },

    async createTab(sessionId) {
      const groupId = await liveGroup(sessionId);
      if (groupId == null) throw new Error(NO_GROUP_MESSAGE);
      const [member] = await api.tabs.query({ groupId });
      const tab = await api.tabs.create({ windowId: member.windowId, url: "about:blank", active: false });
      await api.tabs.group({ groupId, tabIds: [tab.id] });
      return tab;
    },

    async ownedTab(sessionId, tabId) {
      const groupId = await liveGroup(sessionId);
      if (groupId == null) throw new Error(NO_GROUP_MESSAGE);
      const tab = await api.tabs.get(tabId).catch(() => null);
      if (tab?.groupId === groupId) return tab;
      const valid = (await api.tabs.query({ groupId })).map((t) => t.id);
      throw new Error(`Tab ${tabId} is not in this session's tab group. Valid tab IDs: ${valid.join(", ") || "none"}`);
    },

    async adoptOpened(tab) {
      if (tab.openerTabId == null) return;
      const opener = await api.tabs.get(tab.openerTabId).catch(() => null);
      if (!opener || ![...groups.values()].includes(opener.groupId)) return;
      await api.tabs.group({ groupId: opener.groupId, tabIds: [tab.id] });
    },

    close(sessionId) {
      groups.delete(sessionId);
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (46 tests).

- [ ] **Step 7: Commit**

```bash
git add extension/background/reassemble.js extension/background/dispatch.js extension/background/sessions.js test/unit/reassemble.test.js test/unit/dispatch.test.js test/unit/sessions.test.js
git commit -m "Add extension background core: reassembly, dispatcher, session tab groups"
```

---

### Task 6: Extension wiring, tab tools and the end-to-end harness

**Files:**
- Create: `extension/manifest.json`, `extension/background/background.html`, `extension/background/main.js`, `extension/background/native.js`, `extension/background/content.js`, `extension/background/activity.js`, `extension/background/tools/tabs.js`, `extension/content/router.js`
- Create: `test/e2e/harness.js`, `test/e2e/fixtures.js`, `test/e2e/pages/basic.html`, `test/e2e/e2e.test.js`

**Interfaces:**
- Consumes: Task 5 factories; `HOST_NAME`, `SOCKET_PATH`, `nativeManifestPath` (Task 2)
- Produces:
  - `connectNative({ api, name, onMessage }) → { send(msg) }`
  - `createContent(api) → { call(tabId, frameId, op, args?) → Promise<value> }`. It throws the content script's error message, or `Cannot access this page (<url>): Firefox does not allow extensions here.`
  - `createActivity({ api, content }) → { start(tabId), end(tabId) }`. It calls content ops `indicator.show` / `indicator.hideSoon` best-effort; they exist from Task 13.
  - `tabTools({ api, sessions })` → `tabs_context`, `tabs_create`, `tabs_close`, `navigate`, `resize_window`
  - Content router: message `{ op: "<module>.<fn>", args }` → `{ value }` | `{ error }`
  - E2E harness: `startHarness() → { fixtures: { a, b }, call(name, args), connect() → { call, close }, close() }`; `textOf(result)`, `imagesOf(result)`
  - E2E helper (in `e2e.test.js`): `openTab(path, origin?) → tabId`
  - `main.js` holds a `const tools = { … }` object that later tasks extend with one spread line each

- [ ] **Step 1: Write the manifest, background page and router**

`extension/manifest.json`:
```json
{
  "manifest_version": 2,
  "name": "Claude in Firefox",
  "version": "0.1.0",
  "description": "Lets Claude Code drive this Firefox through a local MCP bridge.",
  "browser_specific_settings": { "gecko": { "id": "claude-firefox-bridge@local", "strict_min_version": "139.0" } },
  "permissions": ["nativeMessaging", "tabs", "tabGroups", "<all_urls>", "webRequest", "webNavigation", "clipboardWrite"],
  "background": { "page": "background/background.html", "persistent": true },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "all_frames": true,
      "match_about_blank": true,
      "run_at": "document_start",
      "js": ["content/router.js"]
    }
  ]
}
```

`extension/background/background.html`:
```html
<!doctype html>
<meta charset="utf-8">
<script type="module" src="main.js"></script>
```

`extension/content/router.js`:
```js
(() => {
  if (globalThis.__cf?.routerInstalled) return;
  const cf = (globalThis.__cf ??= {});
  cf.routerInstalled = true;
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.op !== "string") return undefined;
    const [module, fn] = msg.op.split(".");
    const target = cf[module]?.[fn];
    if (typeof target !== "function") return Promise.resolve({ error: `Unknown content op ${msg.op}` });
    return Promise.resolve()
      .then(() => target(msg.args ?? {}))
      .then((value) => ({ value }), (err) => ({ error: err?.message || String(err) }));
  });
})();
```

- [ ] **Step 2: Write native.js, content.js and activity.js**

`extension/background/native.js`:
```js
import { createReassembler } from "./reassemble.js";

export function connectNative({ api, name, onMessage }) {
  const reassembler = createReassembler();
  let port = null;
  let delay = 1000;

  const connect = () => {
    port = api.runtime.connectNative(name);
    port.onMessage.addListener((msg) => {
      delay = 1000;
      const full = msg.type === "part" ? reassembler.push(msg) : msg;
      if (full) onMessage(full);
    });
    port.onDisconnect.addListener((p) => {
      console.warn(`Claude in Firefox: native host disconnected (${p.error?.message ?? "closed"}); retrying in ${delay / 1000}s`);
      port = null;
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
  };
  connect();

  return { send: (msg) => port?.postMessage(msg) };
}
```

`extension/background/content.js`:
```js
const NO_LISTENER = /Receiving end does not exist|Could not establish connection/i;

export function createContent(api) {
  async function inject(tabId, frameId) {
    const [main, topOnly] = api.runtime.getManifest().content_scripts;
    const files = [...main.js, ...(frameId === 0 && topOnly ? topOnly.js : [])];
    for (const file of files) await api.tabs.executeScript(tabId, { file: `/${file}`, frameId, runAt: "document_start" });
  }

  return {
    async call(tabId, frameId, op, args = {}) {
      const send = () => api.tabs.sendMessage(tabId, { op, args }, { frameId });
      let response;
      try {
        response = await send();
      } catch (err) {
        if (!NO_LISTENER.test(err?.message ?? "")) throw err;
        try {
          await inject(tabId, frameId);
        } catch {
          const tab = await api.tabs.get(tabId);
          throw new Error(`Cannot access this page (${tab.url}): Firefox does not allow extensions here.`);
        }
        response = await send();
      }
      if (response === undefined) throw new Error(`The page did not answer ${op}`);
      if (response.error) throw new Error(response.error);
      return response.value;
    },
  };
}
```

`extension/background/activity.js`:
```js
export function createActivity({ api, content }) {
  const running = new Map();
  const show = (tabId) => content.call(tabId, 0, "indicator.show").catch(() => {});

  api.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "complete" && running.has(tabId)) show(tabId);
  });

  return {
    start(tabId) {
      running.set(tabId, (running.get(tabId) ?? 0) + 1);
      show(tabId);
    },
    end(tabId) {
      const remaining = (running.get(tabId) ?? 1) - 1;
      if (remaining > 0) {
        running.set(tabId, remaining);
        return;
      }
      running.delete(tabId);
      content.call(tabId, 0, "indicator.hideSoon").catch(() => {});
    },
  };
}
```

- [ ] **Step 3: Write the tab tools and main.js**

`extension/background/tools/tabs.js`:
```js
const NAVIGATION_TIMEOUT_MS = 15_000;

export function tabTools({ api, sessions }) {
  return {
    tabs_context: {
      tabScoped: false,
      async run({ sessionId, args }) {
        const context = await sessions.context(sessionId, { createIfEmpty: args.createIfEmpty === true });
        return context ? JSON.stringify(context) : "This session has no tab group yet. Call tabs_context with createIfEmpty: true to create one.";
      },
    },
    tabs_create: {
      tabScoped: false,
      async run({ sessionId }) {
        const tab = await sessions.createTab(sessionId);
        return `Created tab ${tab.id}`;
      },
    },
    tabs_close: {
      tabScoped: true,
      async run({ tab }) {
        await api.tabs.remove(tab.id);
        return `Closed tab ${tab.id}`;
      },
    },
    navigate: {
      tabScoped: true,
      run: ({ tab, args }) => navigate(api, tab, args.url),
    },
    resize_window: {
      tabScoped: true,
      async run({ tab, args }) {
        const width = Math.round(Number(args.width));
        const height = Math.round(Number(args.height));
        if (!(width >= 100 && width <= 7680 && height >= 100 && height <= 4320)) throw new Error("resize_window: width must be 100-7680 and height 100-4320");
        await api.windows.update(tab.windowId, { state: "normal", width, height });
        return `Resized window to ${width}x${height}`;
      },
    },
  };
}

async function navigate(api, tab, url) {
  if (typeof url !== "string" || !url.trim()) throw new Error("navigate: url is required");
  const finished = waitForNavigation(api, tab.id, NAVIGATION_TIMEOUT_MS);
  if (url === "back") await api.tabs.goBack(tab.id);
  else if (url === "forward") await api.tabs.goForward(tab.id);
  else await api.tabs.update(tab.id, { url: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}` });
  const loaded = await finished;
  const now = await api.tabs.get(tab.id);
  return loaded ? `Navigated to ${now.url} — "${now.title}"` : `Navigation to ${now.url} started but the page is still loading after 15s`;
}

function waitForNavigation(api, tabId, timeoutMs) {
  const events = [api.webNavigation.onCompleted, api.webNavigation.onHistoryStateUpdated, api.webNavigation.onReferenceFragmentUpdated, api.webNavigation.onErrorOccurred];
  return new Promise((resolve) => {
    const listener = (details) => { if (details.tabId === tabId && details.frameId === 0) finish(true); };
    const finish = (value) => {
      clearTimeout(timer);
      for (const event of events) event.removeListener(listener);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    for (const event of events) event.addListener(listener);
  });
}
```

`extension/background/main.js`:
```js
import { createActivity } from "./activity.js";
import { createContent } from "./content.js";
import { createDispatcher } from "./dispatch.js";
import { connectNative } from "./native.js";
import { createSessions } from "./sessions.js";
import { tabTools } from "./tools/tabs.js";

const api = browser;
const content = createContent(api);
const sessions = createSessions(api);
const activity = createActivity({ api, content });

api.tabs.onCreated.addListener((tab) => {
  sessions.adoptOpened(tab).catch(() => {});
});

const tools = {
  ...tabTools({ api, sessions }),
};

let native = null;
const dispatch = createDispatcher({ tools, sessions, activity, send: (msg) => native.send(msg) });
native = connectNative({ api, name: "claude_firefox_bridge", onMessage: dispatch });
```

- [ ] **Step 4: Lint the extension**

Run: `npm run lint`
Expected: `errors 0` (warnings such as a missing icon are acceptable).

- [ ] **Step 5: Write the e2e fixture server, harness and first fixture page**

`test/e2e/fixtures.js`:
```js
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PAGES = fileURLToPath(new URL("./pages/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".txt": "text/plain" };

function handler(req, res) {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/api/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"pong":true}');
    return;
  }
  const file = path.join(PAGES, path.normalize(url.pathname).replace(/^\/+/, ""));
  if (!file.startsWith(PAGES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const headers = { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" };
  if (path.basename(file).startsWith("csp-")) headers["content-security-policy"] = "script-src 'self'";
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

export async function startFixtures() {
  const a = http.createServer(handler);
  const b = http.createServer(handler);
  await new Promise((resolve) => a.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => b.listen(0, "localhost", resolve));
  const stop = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return {
    a: `http://127.0.0.1:${a.address().port}`,
    b: `http://localhost:${b.address().port}`,
    close: () => Promise.all([stop(a), stop(b)]),
  };
}
```

`test/e2e/harness.js`:
```js
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SOCKET_PATH, nativeManifestPath } from "../../host/src/paths.js";
import { startFixtures } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIREFOX = process.env.FIREFOX_BIN ?? "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox";

export const textOf = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
export const imagesOf = (result) => result.content.filter((b) => b.type === "image");

const socketIsLive = () => new Promise((resolve) => {
  const probe = net.connect(SOCKET_PATH);
  probe.once("connect", () => { probe.destroy(); resolve(true); });
  probe.once("error", () => resolve(false));
});

async function waitFor(check, timeoutMs, message) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message());
}

export async function startHarness() {
  if (!fs.existsSync(nativeManifestPath())) throw new Error("Native host manifest missing. Run `npm run install-host` first.");
  if (await socketIsLive()) throw new Error(`${SOCKET_PATH} is already served. Quit Firefox Developer Edition before running e2e.`);
  const fixtures = await startFixtures();
  const webExt = spawn(path.join(ROOT, "node_modules/.bin/web-ext"), [
    "run", "--source-dir", path.join(ROOT, "extension"), "--firefox", FIREFOX,
    "--no-reload", "--no-input", "--pref", "browser.tabs.groups.enabled=true", "--start-url", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  webExt.stdout.on("data", (d) => { output += d; });
  webExt.stderr.on("data", (d) => { output += d; });
  try {
    await waitFor(socketIsLive, 90_000, () => `The extension never connected. web-ext output:\n${output}`);
  } catch (err) {
    webExt.kill("SIGINT");
    await fixtures.close();
    throw err;
  }

  const clients = [];
  const connect = async () => {
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "host/src/mcp-server.js")] }));
    clients.push(client);
    return {
      call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }),
      close: () => client.close(),
    };
  };
  const main = await connect();

  return {
    fixtures,
    connect,
    call: main.call,
    async close() {
      for (const client of clients) await client.close().catch(() => {});
      webExt.kill("SIGINT");
      await new Promise((resolve) => {
        const timer = setTimeout(() => { webExt.kill("SIGKILL"); resolve(); }, 15_000);
        webExt.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      await fixtures.close();
    },
  };
}
```

`test/e2e/pages/basic.html`:
```html
<!doctype html><title>Basic page</title><h1>Basic</h1><p>Plain fixture page.</p>
```

- [ ] **Step 6: Write the first e2e tests**

`test/e2e/e2e.test.js`:
```js
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
```

- [ ] **Step 7: Install the native host (user-approved) and run e2e**

Ask the user: "OK to run `npm run install-host`? It writes `~/Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json` and `host/bin/native-host`." After a yes:

```bash
npm run install-host
npm test
npm run e2e
```
Expected: unit tests PASS (46); e2e PASS (7 tests in "tabs and navigation"). A Firefox Developer Edition window opens and closes during the run.

- [ ] **Step 8: Commit**

```bash
git add extension/manifest.json extension/background/background.html extension/background/main.js extension/background/native.js extension/background/content.js extension/background/activity.js extension/background/tools/tabs.js extension/content/router.js test/e2e/harness.js test/e2e/fixtures.js test/e2e/pages/basic.html test/e2e/e2e.test.js
git commit -m "Wire the extension to the native host and add tab tools with e2e harness"
```

---
### Task 7: Accessibility tree (content script) and tree rendering

**Files:**
- Create: `extension/content/tree.js`, `extension/background/tree.js`, `test/unit/helpers/dom.js`
- Modify: `extension/manifest.json` (insert `content/tree.js` before `content/router.js`)
- Test: `test/unit/tree.test.js`

**Interfaces:**
- Consumes: the router convention (Task 6)
- Produces:
  - Content `__cf.tree`:
    - `build({ filter?, depth?, refId?, framePrefix? }) → { nodes, truncated, viewport: {width, height} }`
    - `resolve(ref) → Element`, which throws `Element <ref> not found — it may have been removed. Call read_page or find again.`
    - `isSensitive(el) → boolean`
  - Node shape: `{ level, role, ref?, name?, interactive?, checked?, selected?, disabled?, href?, type?, placeholder?, value?, frame? }`. Option nodes have no `ref`. `frame` holds the Firefox frameId of a cross-origin iframe whose contents the background splices in.
  - Refs: `ref_<n>` in the top frame and `f<frameId>_ref_<n>` in a cross-origin frame (the prefix comes from `framePrefix`)
  - `extension/background/tree.js`:
    - `parseRef(ref) → { frameId, ref }`
    - `renderNode(node) → string`
    - `renderTree(nodes, { maxChars?, truncatedNodes?, focused? }) → string`
    - `truncateAtLine(text, maxChars, hint) → string`
    - `scoreNodes(nodes, query) → Array<{ node, score, index }>`
    - `formatFind(hits, query) → string`
  - `test/unit/helpers/dom.js`:
    - `loadContent(html, files?, { url? }) → window`, which stubs `PointerEvent`, `scrollIntoView`, `checkVisibility`, `execCommand` (returns false) and `innerText`
    - `stubLayout(window)`, where elements with `data-offscreen` sit at top 5000
    - `stubElementFromPoint(window, pick)`
    - `plain(value)`, a JSON round-trip that strips jsdom-realm prototypes before `deepEqual`

- [ ] **Step 1: Write the jsdom helper**

`test/unit/helpers/dom.js`:
```js
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const CONTENT = new URL("../../../extension/content/", import.meta.url);

export function loadContent(html, files = ["tree.js"], { url = "https://example.test/page" } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Test</title></head><body>${html}</body></html>`, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.PointerEvent ??= w.MouseEvent;
  w.Element.prototype.scrollIntoView = function scrollIntoView() {};
  w.Element.prototype.checkVisibility = function checkVisibility() { return true; };
  w.Document.prototype.execCommand = function execCommand() { return false; };
  Object.defineProperty(w.HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
  for (const file of files) w.eval(readFileSync(new URL(file, CONTENT), "utf8"));
  return w;
}

export function stubLayout(w) {
  w.Element.prototype.getClientRects = function getClientRects() { return [{}]; };
  w.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const top = this.hasAttribute("data-offscreen") ? 5000 : 10;
    return { left: 10, top, right: 110, bottom: top + 20, width: 100, height: 20, x: 10, y: top };
  };
}

export function stubElementFromPoint(w, pick) {
  w.Document.prototype.elementFromPoint = function elementFromPoint(x, y) { return pick(x, y, this); };
}

// Objects created inside the jsdom realm have that realm's prototypes, which deepStrictEqual rejects.
export const plain = (value) => JSON.parse(JSON.stringify(value));
```

- [ ] **Step 2: Write the failing tests**

`test/unit/tree.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { formatFind, parseRef, renderTree, scoreNodes } from "../../extension/background/tree.js";
import { loadContent, stubLayout } from "./helpers/dom.js";

const render = (w, args = {}) => renderTree(w.__cf.tree.build(args).nodes);

test("roles, names, refs and attributes follow the line format", () => {
  const w = loadContent(`<nav><a href="/home">Home</a></nav><main><h1>Sign in</h1><form>
    <label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" value="a@b.c">
    <label><input type="checkbox" checked> Remember me</label>
    <button type="submit" disabled><span>Log in</span></button></form></main>`);
  const text = render(w);
  assert.match(text, /^navigation \[ref_\d+\]$/m);
  assert.match(text, /^ link "Home" \[ref_\d+\] href="\/home"$/m);
  assert.match(text, /^ heading "Sign in" \[ref_\d+\]$/m);
  assert.match(text, /textbox "Email" \[ref_\d+\] type="email" placeholder="you@example.com" value="a@b.c"/);
  assert.match(text, /checkbox "Remember me" \[ref_\d+\] \(checked\) type="checkbox"/);
  assert.match(text, /button "Log in" \[ref_\d+\] \(disabled\) type="submit"/);
});

test("password, one-time-code and card values are redacted and hidden inputs skipped", () => {
  const w = loadContent(`<input type="password" value="hunter2"><input autocomplete="one-time-code" value="123456">
    <input autocomplete="cc-number" value="4111111111111111"><input type="hidden" value="csrf-token">
    <select autocomplete="cc-exp-month"><option selected>01</option><option>02</option></select>`);
  const text = render(w);
  for (const secret of ["hunter2", "123456", "4111", "csrf-token"]) assert.ok(!text.includes(secret), secret);
  assert.equal(text.match(/value="\[value redacted\]"/g).length, 3);
  assert.match(text, /combobox "\[value redacted\]" \[ref_\d+\]/);
  assert.doesNotMatch(text, /option/);
});

test("select options are listed once under the select with selection and differing values", () => {
  const w = loadContent(`<label>Country <select><option value="us" selected>United States</option><option value="kr">Korea</option><option>Japan</option></select></label>`);
  const text = render(w);
  assert.match(text, /^label "Country" \[ref_\d+\]\n combobox "Country" \[ref_\d+\]\n  option "United States" \(selected\) value="us"\n  option "Korea" value="kr"\n  option "Japan"$/m);
});

test("refs are stable across builds and resolve to their elements", () => {
  const w = loadContent(`<button id="b">Press</button>`);
  const first = w.__cf.tree.build().nodes.find((n) => n.name === "Press").ref;
  w.document.body.insertAdjacentHTML("afterbegin", "<a href='#'>New link</a>");
  const second = w.__cf.tree.build().nodes.find((n) => n.name === "Press").ref;
  assert.equal(first, second);
  assert.equal(w.__cf.tree.resolve(first), w.document.getElementById("b"));
});

test("removed elements give a helpful stale-ref error", () => {
  const w = loadContent(`<button id="b">Press</button>`);
  const ref = w.__cf.tree.build().nodes[0].ref;
  w.document.getElementById("b").remove();
  assert.throws(() => w.__cf.tree.resolve(ref), new RegExp(`Element ${ref} not found — it may have been removed`));
  assert.throws(() => w.__cf.tree.resolve("ref_999"), /Element ref_999 not found/);
});

test("the interactive filter keeps only visible, on-screen controls", () => {
  const w = loadContent(`<button>On screen</button><button style="display:none">Hidden one</button>
    <button data-offscreen>Far below</button><p>Just a paragraph</p><button aria-hidden="true">Aria hidden</button>`);
  stubLayout(w);
  const text = render(w, { filter: "interactive" });
  assert.match(text, /button "On screen"/);
  assert.doesNotMatch(text, /Hidden one|Far below|Just a paragraph|Aria hidden/);
});

test("open shadow roots and same-origin iframes are traversed", () => {
  const w = loadContent(`<div id="host"></div><iframe id="f"></iframe>`);
  w.document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<button>Shadow button</button>";
  w.document.getElementById("f").contentDocument.body.innerHTML = "<a href='/in-frame'>Inside frame</a>";
  const text = render(w);
  assert.match(text, /button "Shadow button" \[ref_\d+\]/);
  assert.match(text, /^iframe \[ref_\d+\]\n link "Inside frame" \[ref_\d+\] href="\/in-frame"$/m);
});

test("refId focuses on one subtree and the frame prefix marks refs", () => {
  const w = loadContent(`<nav id="n"><a href="/a">Alpha</a></nav><main><a href="/b">Beta</a></main>`);
  const navRef = w.__cf.tree.build().nodes.find((n) => n.role === "navigation").ref;
  const text = render(w, { refId: navRef });
  assert.match(text, /Alpha/);
  assert.doesNotMatch(text, /Beta/);
  const framed = loadContent(`<button>X-ray</button>`);
  assert.match(framed.__cf.tree.build({ framePrefix: "f7_" }).nodes[0].ref, /^f7_ref_\d+$/);
});

test("very large pages are capped at 10000 nodes with a truncation note", () => {
  const w = loadContent(`<ul>${"<li><a href='#'>item</a></li>".repeat(6000)}</ul>`);
  const started = Date.now();
  const result = w.__cf.tree.build();
  assert.equal(result.truncated, true);
  assert.equal(result.nodes.length, 10_000);
  assert.ok(Date.now() - started < 10_000, "tree build should finish quickly");
  assert.match(renderTree(result.nodes, { truncatedNodes: true }), /\[truncated at 10000 elements/);
});

test("renderTree truncates at a line boundary with a note", () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({ level: 0, role: "button", name: `Button ${i}`, ref: `ref_${i}` }));
  const text = renderTree(nodes, { maxChars: 200 });
  const [body] = text.split("\n[output truncated");
  assert.ok(body.length <= 200);
  assert.ok(body.endsWith("]"));
  assert.match(text, /\[output truncated at \d+ of \d+ characters\. Pass a larger max_chars/);
  assert.equal(renderTree([]), "(no elements matched)");
});

test("parseRef reads frame prefixes and rejects anything else", () => {
  assert.deepEqual(parseRef("ref_12"), { frameId: 0, ref: "ref_12" });
  assert.deepEqual(parseRef("f7_ref_3"), { frameId: 7, ref: "f7_ref_3" });
  assert.throws(() => parseRef("button"), /Invalid ref "button"/);
});

test("find ranks name matches first and formats hits", () => {
  const nodes = [
    { level: 0, role: "button", name: "Cancel", ref: "ref_1", interactive: true },
    { level: 0, role: "button", name: "Subscribe now", ref: "ref_2", interactive: true },
    { level: 0, role: "textbox", name: "Search", ref: "ref_3", placeholder: "Search products", interactive: true },
    { level: 0, role: "heading", name: "Subscribe to our newsletter", ref: "ref_4" },
    { level: 1, role: "option", name: "Subscribe" },
  ];
  assert.equal(scoreNodes(nodes, "subscribe button")[0].node.ref, "ref_2");
  assert.equal(scoreNodes(nodes, "search box")[0].node.ref, "ref_3");
  assert.ok(scoreNodes(nodes, "subscribe").every((hit) => hit.node.ref));
  assert.deepEqual(scoreNodes(nodes, "zebra"), []);
  assert.match(formatFind(scoreNodes(nodes, "zebra"), "zebra"), /^No elements matched "zebra"/);
  assert.match(formatFind(scoreNodes(nodes, "cancel"), "cancel"), /^Found 1 element\(s\) matching "cancel", best first:\n\n- ref_1: button "Cancel"$/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL: `ENOENT … extension/content/tree.js` and `Cannot find module '…/extension/background/tree.js'`.

- [ ] **Step 4: Implement the content tree**

`extension/content/tree.js`:
```js
(() => {
  if (globalThis.__cf?.tree) return;
  const cf = (globalThis.__cf ??= {});

  const MAX_NODES = 10_000;
  const REDACTED = "[value redacted]";
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "NOSCRIPT", "TEMPLATE", "CLAUDE-FIREFOX-INDICATOR"]);
  const LANDMARK_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "NAV", "MAIN", "HEADER", "FOOTER", "SECTION", "ARTICLE", "ASIDE"]);
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"]);
  const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "textbox", "searchbox", "combobox", "slider", "spinbutton", "treeitem"]);
  const NAME_FROM_CONTENT = new Set(["button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "cell", "columnheader", "rowheader", "tooltip", "switch", "checkbox", "radio"]);
  const TAG_ROLES = {
    BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "image", NAV: "navigation", MAIN: "main", HEADER: "banner",
    FOOTER: "contentinfo", SECTION: "region", ARTICLE: "article", ASIDE: "complementary", FORM: "form", TABLE: "table",
    UL: "list", OL: "list", LI: "listitem", LABEL: "label", DIALOG: "dialog", DETAILS: "group", SUMMARY: "button",
    OPTION: "option", IFRAME: "iframe", FRAME: "iframe",
  };
  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button", file: "button", search: "searchbox", range: "slider", number: "spinbutton" };
  const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden"]);
  const SENSITIVE_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)\b/;

  const refs = new Map();
  const refOf = new WeakMap();
  let counter = 0;

  const tagOf = (el) => el.tagName.toUpperCase();
  const clean = (value, max = 100) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };

  function isSensitive(el) {
    if (tagOf(el) === "INPUT" && (el.type === "password" || el.type === "hidden")) return true;
    return SENSITIVE_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "");
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = tagOf(el);
    if (tag === "INPUT") return INPUT_ROLES[el.type] || "textbox";
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (/^H[1-6]$/.test(tag)) return "heading";
    return TAG_ROLES[tag] || "generic";
  }

  function textExcluding(node, skip) {
    let text = "";
    for (const child of node.childNodes) {
      if (child === skip) continue;
      if (child.nodeType === 3) text += child.textContent;
      else if (child.nodeType === 1) text += ` ${textExcluding(child, skip)} `;
    }
    return text;
  }

  function directText(el) {
    let text = "";
    for (const child of el.childNodes) if (child.nodeType === 3) text += child.textContent;
    return text;
  }

  function labelText(el) {
    let text = "";
    if (el.id) for (const label of el.ownerDocument.querySelectorAll("label[for]")) if (label.htmlFor === el.id) text += ` ${textExcluding(label, el)}`;
    const wrapping = el.closest("label");
    if (wrapping) text += ` ${textExcluding(wrapping, el)}`;
    return text;
  }

  function nameOf(el, role) {
    const tag = tagOf(el);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = clean(labelledBy.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "").join(" "));
      if (text) return text;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      const label = clean(labelText(el));
      if (label) return label;
    }
    for (const attr of ["placeholder", "title", "alt"]) {
      const value = clean(el.getAttribute(attr));
      if (value) return value;
    }
    if (tag === "SELECT") return isSensitive(el) ? REDACTED : clean(el.selectedOptions[0]?.textContent);
    if (tag === "INPUT") return ["submit", "button", "reset"].includes(el.type) ? clean(el.value) : "";
    if (tag === "TEXTAREA") return "";
    if (NAME_FROM_CONTENT.has(role)) return clean(el.textContent);
    const direct = clean(directText(el));
    return direct.length >= 3 ? direct : "";
  }

  function fieldValue(el) {
    const tag = tagOf(el);
    const textual = tag === "TEXTAREA" || (tag === "INPUT" && !NON_TEXT_INPUTS.has(el.type));
    if (!textual || !el.value) return null;
    return isSensitive(el) ? REDACTED : clean(el.value);
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_TAGS.has(tagOf(el))) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
    const editable = el.getAttribute("contenteditable");
    if (editable === "" || editable === "true" || editable === "plaintext-only") return true;
    return INTERACTIVE_ROLES.has(role);
  }

  function isVisible(el) {
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    return el.getClientRects().length > 0;
  }

  function inViewport(el) {
    const rect = el.getBoundingClientRect();
    const win = el.ownerDocument.defaultView;
    return rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
  }

  function refFor(el, prefix) {
    const known = refOf.get(el);
    if (known && refs.get(known)?.deref() === el) return known;
    const ref = `${prefix}ref_${++counter}`;
    refs.set(ref, new WeakRef(el));
    refOf.set(el, ref);
    return ref;
  }

  function resolve(ref) {
    const el = refs.get(ref)?.deref();
    if (!el || !el.isConnected) {
      refs.delete(ref);
      throw new Error(`Element ${ref} not found — it may have been removed. Call read_page or find again.`);
    }
    return el;
  }

  function describe(el, role, name, level, prefix, interactive) {
    const node = { level, role, ref: refFor(el, prefix) };
    if (name) node.name = name;
    if (interactive) node.interactive = true;
    if (el.checked === true || el.getAttribute("aria-checked") === "true") node.checked = true;
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") node.disabled = true;
    for (const attr of ["href", "type", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (value && !(attr === "placeholder" && value === name)) node[attr] = clean(value, 200);
    }
    const value = fieldValue(el);
    if (value != null) node.value = value;
    return node;
  }

  function optionNode(option, level) {
    const node = { level, role: "option", name: clean(option.textContent) };
    if (option.selected) node.selected = true;
    if (option.value !== option.textContent.trim()) node.value = clean(option.value, 200);
    return node;
  }

  function childrenOf(el) {
    const root = el.openOrClosedShadowRoot ?? el.shadowRoot;
    return root ? [...root.children, ...el.children] : [...el.children];
  }

  function frameDocument(el) {
    try {
      return el.contentDocument;
    } catch {
      return null;
    }
  }

  function build({ filter = "all", depth = 15, refId = null, framePrefix = "" } = {}) {
    const root = refId ? resolve(refId) : document.body ?? document.documentElement;
    const nodes = [];
    let truncated = false;

    const visit = (el, level) => {
      if (nodes.length >= MAX_NODES) {
        truncated = true;
        return;
      }
      if (level > depth) return;
      const tag = tagOf(el);
      if (SKIP_TAGS.has(tag) || (tag === "INPUT" && el.type === "hidden")) return;
      const role = roleOf(el);
      const name = nameOf(el, role);
      const interactive = isInteractive(el, role);
      const isFrame = tag === "IFRAME" || tag === "FRAME";
      const include = isFrame || (refId != null && el === root) || (filter === "interactive"
        ? interactive && el.getAttribute("aria-hidden") !== "true" && isVisible(el) && (refId != null || inViewport(el))
        : interactive || LANDMARK_TAGS.has(tag) || el.hasAttribute("role") || name !== "" || (role !== "generic" && role !== "image"));
      let childLevel = level;
      if (include) {
        nodes.push(describe(el, role, name, level, framePrefix, interactive));
        childLevel = level + 1;
        if (tag === "SELECT") {
          if (!isSensitive(el)) for (const option of el.options) nodes.push(optionNode(option, childLevel));
          return;
        }
      }
      if (isFrame) {
        const doc = frameDocument(el);
        if (doc?.body) visit(doc.body, childLevel);
        else {
          const frameId = browser.runtime.getFrameId(el);
          if (frameId > 0) nodes[nodes.length - 1].frame = frameId;
        }
        return;
      }
      for (const child of childrenOf(el)) visit(child, childLevel);
    };

    visit(root, 0);
    return { nodes, truncated, viewport: { width: innerWidth, height: innerHeight } };
  }

  cf.tree = { build, resolve, isSensitive };
})();
```

- [ ] **Step 5: Implement the background tree helpers**

`extension/background/tree.js`:
```js
const REF_PATTERN = /^(?:f(\d+)_)?ref_\d+$/;
const STOPWORDS = new Set(["the", "a", "an", "to", "of", "for", "in", "on", "with", "and", "or"]);
const ROLE_WORDS = {
  button: ["button", "btn"],
  link: ["link", "anchor"],
  textbox: ["textbox", "input", "field", "box", "bar", "text"],
  searchbox: ["searchbox", "search", "input", "field", "box", "bar"],
  combobox: ["combobox", "dropdown", "select", "menu"],
  checkbox: ["checkbox", "check", "tick"],
  radio: ["radio", "option"],
  heading: ["heading", "title", "header"],
  image: ["image", "img", "picture", "icon"],
  menuitem: ["menu", "item"],
};

export function parseRef(ref) {
  const match = REF_PATTERN.exec(String(ref ?? ""));
  if (!match) throw new Error(`Invalid ref "${ref}" — use a ref from read_page or find, e.g. "ref_12".`);
  return { frameId: match[1] ? Number(match[1]) : 0, ref: match[0] };
}

const quote = (value) => String(value).replace(/"/g, '\\"');

export function renderNode(node) {
  let line = `${" ".repeat(node.level)}${node.role}`;
  if (node.name) line += ` "${quote(node.name)}"`;
  if (node.ref) line += ` [${node.ref}]`;
  if (node.checked) line += " (checked)";
  if (node.selected) line += " (selected)";
  if (node.disabled) line += " (disabled)";
  for (const key of ["href", "type", "placeholder", "value"]) if (node[key] != null) line += ` ${key}="${quote(node[key])}"`;
  if (node.frame) line += ` [frame ${node.frame}]`;
  return line;
}

export function truncateAtLine(text, maxChars, hint) {
  if (text.length <= maxChars) return text;
  let cut = text.lastIndexOf("\n", maxChars);
  if (cut <= 0) cut = maxChars;
  return `${text.slice(0, cut)}\n[output truncated at ${cut} of ${text.length} characters. ${hint}]`;
}

export function renderTree(nodes, { maxChars = 50_000, truncatedNodes = false, focused = false } = {}) {
  if (!nodes.length) return "(no elements matched)";
  let text = nodes.map(renderNode).join("\n");
  if (truncatedNodes) text += `\n[truncated at 10000 elements — use ${focused ? "a smaller depth or a more specific ref_id" : "ref_id or a smaller depth"} to focus]`;
  return truncateAtLine(text, maxChars, "Pass a larger max_chars, or use ref_id or a smaller depth to focus.");
}

const tokenize = (text) => String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOPWORDS.has(t));

export function scoreNodes(nodes, query) {
  const phrase = String(query ?? "").toLowerCase().trim();
  const tokens = tokenize(query);
  const hits = [];
  nodes.forEach((node, index) => {
    if (!node.ref) return;
    const name = (node.name ?? "").toLowerCase();
    const extra = [node.placeholder, node.href, node.type, node.value].filter(Boolean).join(" ").toLowerCase();
    const roleWords = ROLE_WORDS[node.role] ?? [node.role];
    let score = phrase && name.includes(phrase) ? 5 : 0;
    for (const token of tokens) {
      if (name.includes(token)) score += 3;
      if (roleWords.includes(token)) score += 2;
      if (extra.includes(token)) score += 1;
    }
    if (score > 0 && node.interactive) score += 1;
    if (score > 0) hits.push({ node, score, index });
  });
  return hits.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 20);
}

export function formatFind(hits, query) {
  if (!hits.length) return `No elements matched "${query}". Try other words that appear on the page, or use read_page.`;
  const lines = hits.map(({ node }) => `- ${node.ref}: ${renderNode({ ...node, level: 0, ref: undefined })}`);
  return `Found ${hits.length} element(s) matching "${query}", best first:\n\n${lines.join("\n")}`;
}
```

- [ ] **Step 6: Add the content script to the manifest**

In `extension/manifest.json`, change
```json
      "js": ["content/router.js"]
```
to
```json
      "js": ["content/tree.js", "content/router.js"]
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (58 tests).

- [ ] **Step 8: Commit**

```bash
git add extension/content/tree.js extension/background/tree.js extension/manifest.json test/unit/helpers/dom.js test/unit/tree.test.js
git commit -m "Add accessibility-tree content script, rendering and keyword find"
```

---

### Task 8: read_page and find tools

**Files:**
- Create: `extension/background/tools/page.js`, `test/unit/page-tools.test.js`
- Create: `test/e2e/pages/tree.html`, `test/e2e/pages/frames.html`, `test/e2e/pages/frame-inner.html`
- Modify: `extension/background/main.js`, `test/e2e/e2e.test.js` (append)

**Interfaces:**
- Consumes: `content.call` (Task 6); `parseRef`, `renderTree`, `scoreNodes`, `formatFind` (Task 7); content op `tree.build`
- Produces:
  - `collectTree(content, tabId, { filter, depth, refId }) → { nodes, truncated, viewport }`, with cross-origin frames spliced in at `node.level + 1`
  - `pageTools({ content })` → `read_page`, `find`. Task 9 changes the signature to `pageTools({ api, content })`.

- [ ] **Step 1: Write the failing unit test**

`test/unit/page-tools.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { collectTree, pageTools } from "../../extension/background/tools/page.js";

function fakeContent(frames) {
  const calls = [];
  return {
    calls,
    async call(tabId, frameId, op, args) {
      calls.push({ frameId, op, args });
      const frame = frames[frameId];
      if (frame instanceof Error) throw frame;
      return { nodes: frame, truncated: false, viewport: { width: 800, height: 600 } };
    },
  };
}

test("cross-origin frames are spliced in under their iframe with prefixed refs", async () => {
  const content = fakeContent({
    0: [{ level: 0, role: "main", ref: "ref_1" }, { level: 1, role: "iframe", ref: "ref_2", frame: 7 }, { level: 1, role: "button", name: "After", ref: "ref_3" }],
    7: [{ level: 0, role: "button", name: "Inside", ref: "f7_ref_1" }],
  });
  const { nodes } = await collectTree(content, 1, { filter: "all", depth: 15, refId: null });
  assert.deepEqual(nodes.map((n) => [n.level, n.name ?? n.role]), [[0, "main"], [1, "iframe"], [2, "Inside"], [1, "After"]]);
  assert.deepEqual(content.calls.map((c) => [c.frameId, c.args.framePrefix]), [[0, ""], [7, "f7_"]]);
});

test("frame failures become a note instead of failing the whole read", async () => {
  const content = fakeContent({ 0: [{ level: 0, role: "iframe", ref: "ref_1", frame: 9 }], 9: new Error("Cannot access this page") });
  const text = await pageTools({ content }).read_page.run({ tab: { id: 1 }, args: {} });
  assert.match(text, /^iframe \[ref_1\] \[frame 9\]\n note "frame contents unavailable: Cannot access this page"\n\nViewport: 800x600$/);
});

test("a frame-prefixed ref_id is read from that frame", async () => {
  const content = fakeContent({ 7: [{ level: 0, role: "form", ref: "f7_ref_4" }] });
  await pageTools({ content }).read_page.run({ tab: { id: 1 }, args: { ref_id: "f7_ref_4" } });
  assert.deepEqual(content.calls[0], { frameId: 7, op: "tree.build", args: { filter: "all", depth: 15, refId: "f7_ref_4", framePrefix: "f7_" } });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/extension/background/tools/page.js'`.

- [ ] **Step 3: Implement page.js**

`extension/background/tools/page.js`:
```js
import { formatFind, parseRef, renderTree, scoreNodes } from "../tree.js";

const prefixFor = (frameId) => (frameId ? `f${frameId}_` : "");

export async function collectTree(content, tabId, { filter, depth, refId }) {
  const target = refId ? parseRef(refId) : { frameId: 0, ref: null };
  const root = await content.call(tabId, target.frameId, "tree.build", { filter, depth, refId: target.ref, framePrefix: prefixFor(target.frameId) });
  const nodes = await expandFrames(content, tabId, root.nodes, { filter, depth });
  return { nodes, truncated: root.truncated, viewport: root.viewport };
}

async function expandFrames(content, tabId, nodes, options) {
  const out = [];
  for (const node of nodes) {
    out.push(node);
    if (!node.frame) continue;
    let sub;
    try {
      sub = await content.call(tabId, node.frame, "tree.build", { ...options, refId: null, framePrefix: prefixFor(node.frame) });
    } catch (err) {
      out.push({ level: node.level + 1, role: "note", name: `frame contents unavailable: ${err.message}` });
      continue;
    }
    for (const child of await expandFrames(content, tabId, sub.nodes, options)) out.push({ ...child, level: child.level + node.level + 1 });
  }
  return out;
}

export function pageTools({ content }) {
  return {
    read_page: {
      tabScoped: true,
      async run({ tab, args }) {
        const filter = args.filter === "interactive" ? "interactive" : "all";
        const { nodes, truncated, viewport } = await collectTree(content, tab.id, { filter, depth: args.depth ?? 15, refId: args.ref_id ?? null });
        const text = renderTree(nodes, { maxChars: args.max_chars ?? 50_000, truncatedNodes: truncated, focused: !!args.ref_id });
        return `${text}\n\nViewport: ${viewport.width}x${viewport.height}`;
      },
    },
    find: {
      tabScoped: true,
      async run({ tab, args }) {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("find: query is required");
        const { nodes } = await collectTree(content, tab.id, { filter: "all", depth: 100, refId: null });
        return formatFind(scoreNodes(nodes, query), query);
      },
    },
  };
}
```

- [ ] **Step 4: Register the tools in main.js**

In `extension/background/main.js`, add the import after `import { createSessions } from "./sessions.js";`:
```js
import { pageTools } from "./tools/page.js";
```
and extend the `tools` object:
```js
const tools = {
  ...tabTools({ api, sessions }),
  ...pageTools({ content }),
};
```

- [ ] **Step 5: Run the unit tests**

Run: `npm test`
Expected: PASS (61 tests).

- [ ] **Step 6: Add e2e fixtures**

`test/e2e/pages/tree.html`:
```html
<!doctype html><title>Tree page</title>
<nav><a href="/basic.html">Home</a> <a href="/about">About us</a></nav>
<main>
  <h1>Welcome</h1>
  <form>
    <label for="email">Email</label><input id="email" type="email" placeholder="you@example.com">
    <input id="pw" type="password" value="hunter2" aria-label="Password">
    <select aria-label="Country"><option value="us" selected>United States</option><option value="kr">Korea</option></select>
    <button type="submit">Subscribe</button>
  </form>
  <custom-card></custom-card>
  <div style="position:absolute; top:3000px"><button>Far below</button></div>
</main>
<script>
  customElements.define("custom-card", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<button>Shadow action</button>"; }
  });
</script>
```

`test/e2e/pages/frames.html`:
```html
<!doctype html><title>Frames</title>
<style>body{margin:0} #cross{position:absolute;left:20px;top:200px;width:400px;height:200px;border:0}</style>
<h1>Frame host</h1>
<iframe id="same" srcdoc="<button>Same-origin button</button>"></iframe>
<iframe id="cross" title="Cross-origin frame"></iframe>
<script>document.getElementById("cross").src = new URLSearchParams(location.search).get("b") + "/frame-inner.html";</script>
```

`test/e2e/pages/frame-inner.html`:
```html
<!doctype html><title>Inner</title>
<style>body{margin:0} button{position:absolute;left:10px;top:10px;width:150px;height:40px}</style>
<button onclick="document.getElementById('out').textContent = 'frame clicked'">Frame button</button>
<p id="out" style="margin-top:80px">not clicked yet</p>
```

- [ ] **Step 7: Append the e2e tests**

Append to `test/e2e/e2e.test.js`:
```js
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
```

- [ ] **Step 8: Run lint and e2e**

Run: `npm run lint && npm run e2e`
Expected: lint `errors 0`; e2e PASS (13 tests).

- [ ] **Step 9: Commit**

```bash
git add extension/background/tools/page.js extension/background/main.js test/unit/page-tools.test.js test/e2e/pages/tree.html test/e2e/pages/frames.html test/e2e/pages/frame-inner.html test/e2e/e2e.test.js
git commit -m "Add read_page and find tools with cross-origin frame splicing"
```

---

### Task 9: Forms, page text and the domain guard

**Files:**
- Create: `extension/content/dom.js`, `extension/content/text.js`, `extension/content/form.js`, `extension/background/guard.js`
- Create: `test/unit/form.test.js`, `test/unit/guard.test.js`, `test/e2e/pages/forms.html`, `test/e2e/pages/article.html`
- Modify: `extension/manifest.json`, `extension/background/tools/page.js`, `extension/background/main.js`, `test/e2e/e2e.test.js` (append)

**Interfaces:**
- Consumes: `__cf.tree.resolve`, `__cf.tree.isSensitive` (Task 7); `collectTree`, `pageTools` (Task 8); `truncateAtLine`, `parseRef` (Task 7)
- Produces:
  - Content `__cf.dom = { setNativeValue(el, value), isContentEditable(el), guardHost(guard) }`. Here `guard` is `{host, action}` or null.
  - Content `__cf.text = { pageText() → { title, url, tag, text } }`
  - Content `__cf.form = { setValue({ ref, value, guard }) → string }`. Task 16 adds `setFiles`.
  - `extension/background/guard.js`:
    - `hostOf(url)`
    - `domainChangedMessage(action)`
    - `assertSameHost(api, tab, action)`
    - `guardFor(api, tab, frameId, action) → Promise<{host, action} | null>`
  - `pageTools({ api, content })` now also provides `get_page_text`, `form_input`

- [ ] **Step 1: Write the failing tests**

`test/unit/guard.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { domainChangedMessage, guardFor, hostOf } from "../../extension/background/guard.js";

const apiWithUrl = (url) => ({ tabs: { get: async () => ({ id: 1, url }) } });

test("hostOf extracts hostnames and tolerates odd URLs", () => {
  assert.equal(hostOf("https://www.example.test/a?b"), "www.example.test");
  assert.equal(hostOf("about:blank"), "");
  assert.equal(hostOf("not a url"), "");
});

test("guardFor hands frame 0 a host guard and checks other frames immediately", async () => {
  const tab = { id: 1, url: "https://a.test/page" };
  assert.deepEqual(await guardFor(apiWithUrl("https://a.test/other"), tab, 0, "left_click"), { host: "a.test", action: "left_click" });
  assert.equal(await guardFor(apiWithUrl("https://a.test/other"), tab, 7, "left_click"), null);
  await assert.rejects(guardFor(apiWithUrl("https://evil.test/"), tab, 7, "left_click"), { message: domainChangedMessage("left_click") });
});
```

`test/unit/form.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent, plain } from "./helpers/dom.js";

const FILES = ["dom.js", "tree.js", "form.js", "text.js"];
const refByName = (w, name) => {
  const node = w.__cf.tree.build().nodes.find((n) => n.name === name && n.role !== "label");
  assert.ok(node, `no control named ${name}`);
  return node.ref;
};
const set = (w, name, value, guard = null) => w.__cf.form.setValue({ ref: refByName(w, name), value, guard });

test("text inputs use the native setter so React-style value trackers see the change", () => {
  const w = loadContent(`<label for="n">Name</label><input id="n" value="old">`, FILES);
  const el = w.document.getElementById("n");
  const native = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value");
  let tracked = "old";
  Object.defineProperty(el, "value", { configurable: true, get() { return native.get.call(this); }, set(v) { tracked = String(v); native.set.call(this, v); } });
  const changes = [];
  el.addEventListener("input", () => { const now = native.get.call(el); if (now !== tracked) { tracked = now; changes.push(now); } });
  assert.equal(set(w, "Name", "new"), 'Set text value to "new" (previous: "old")');
  assert.deepEqual(changes, ["new"]);
});

test("selects match by value, exact text or case-insensitive text and list options on a miss", () => {
  const w = loadContent(`<label for="c">Country</label><select id="c"><option value="us">United States</option><option value="kr">Korea</option></select>`, FILES);
  const changes = [];
  w.document.getElementById("c").addEventListener("change", (e) => changes.push(e.target.value));
  assert.equal(set(w, "Country", "kr"), 'Selected "Korea" (previous: "United States")');
  set(w, "Country", "united states");
  assert.deepEqual(changes, ["kr", "us"]);
  assert.throws(() => set(w, "Country", "Japan"), /Option "Japan" not found\. Available options: "United States" \(value: "us"\), "Korea" \(value: "kr"\)/);
});

test("checkboxes need booleans and toggle through a click", () => {
  const w = loadContent(`<label><input type="checkbox" id="a"> I agree</label>`, FILES);
  let clicks = 0;
  w.document.getElementById("a").addEventListener("click", () => clicks++);
  assert.throws(() => set(w, "I agree", "yes"), /Checkbox requires a boolean value/);
  assert.equal(set(w, "I agree", true), "Set checkbox to true (previous: false)");
  assert.equal(set(w, "I agree", true), "Set checkbox to true (previous: true)");
  assert.equal(clicks, 1);
});

test("radios are selected, number inputs validated, textareas and contenteditable set", () => {
  const w = loadContent(`<label><input type="radio" name="s" value="l"> Large</label>
    <label for="q">Quantity</label><input id="q" type="number">
    <label for="b">Bio</label><textarea id="b"></textarea>
    <div contenteditable="true" aria-label="Notes">draft</div>`, FILES);
  assert.equal(set(w, "Large", "anything"), 'Selected radio "l"');
  assert.equal(w.document.querySelector("input[name=s]").checked, true);
  assert.throws(() => set(w, "Quantity", "many"), /A number input needs a numeric value/);
  assert.equal(set(w, "Quantity", 3), 'Set number value to "3" (previous: "")');
  assert.equal(set(w, "Bio", "Line one"), 'Set textarea value to "Line one" (previous: "")');
  assert.equal(set(w, "Notes", "final"), 'Set editable content to "final" (previous: "draft")');
});

test("sensitive values are redacted in the output", () => {
  const w = loadContent(`<label for="p">Password</label><input id="p" type="password" value="old-secret">`, FILES);
  assert.equal(set(w, "Password", "new-secret"), "Set password value to [redacted] (previous: [redacted])");
  assert.equal(w.document.getElementById("p").value, "new-secret");
});

test("unsupported elements and file inputs are refused", () => {
  const w = loadContent(`<button>Plain button</button><label for="f">Attachment</label><input id="f" type="file">`, FILES);
  assert.throws(() => set(w, "Plain button", "x"), /<button> is not a supported form input/);
  assert.throws(() => set(w, "Attachment", "x"), /Use file_upload for file inputs/);
});

test("the domain guard stops input when the page host changed", () => {
  const w = loadContent(`<label for="n">Name</label><input id="n">`, FILES, { url: "https://evil.test/" });
  assert.throws(() => set(w, "Name", "x", { host: "good.test", action: "form_input" }), /Page navigated to a different domain during form_input/);
  assert.equal(w.document.getElementById("n").value, "");
});

test("page text prefers the longest matching content element", () => {
  const w = loadContent(`<nav>Site navigation</nav><article>Short</article><article>The   much longer
    article text</article><footer>Footer</footer>`, FILES);
  assert.deepEqual(plain(w.__cf.text.pageText()), { title: "Test", url: "https://example.test/page", tag: "article", text: "The much longer\narticle text" });
});

test("page text falls back to the body", () => {
  const w = loadContent(`<div>Only a div</div>`, FILES);
  assert.equal(w.__cf.text.pageText().tag, "body");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. `extension/background/guard.js` cannot be found, and `extension/content/dom.js` gives ENOENT.

- [ ] **Step 3: Implement the content helpers**

`extension/content/dom.js`:
```js
(() => {
  if (globalThis.__cf?.dom) return;
  const cf = (globalThis.__cf ??= {});
  const VALUE_CLASSES = { INPUT: "HTMLInputElement", TEXTAREA: "HTMLTextAreaElement" };

  // The prototype setter bypasses value properties pages define on the element itself
  // (React's value tracker), so their input listeners see a real change.
  function setNativeValue(el, value) {
    const proto = el.ownerDocument.defaultView[VALUE_CLASSES[el.tagName.toUpperCase()]].prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }

  function isContentEditable(el) {
    const host = el.closest("[contenteditable]");
    return !!host && host.getAttribute("contenteditable") !== "false";
  }

  function guardHost(guard) {
    if (guard && location.hostname !== guard.host) {
      throw new Error(`Page navigated to a different domain during ${guard.action}. Re-read the tab state before retrying.`);
    }
  }

  cf.dom = { setNativeValue, isContentEditable, guardHost };
})();
```

`extension/content/text.js`:
```js
(() => {
  if (globalThis.__cf?.text) return;
  const cf = (globalThis.__cf ??= {});
  const SELECTORS = ["article", "main", '[class*="articleBody"]', '[class*="article-body"]', '[class*="post-content"]', '[class*="entry-content"]', '[class*="content-body"]', '[role="main"]', ".content", "#content"];

  function pageText() {
    let source = null;
    for (const selector of SELECTORS) {
      const matches = [...document.querySelectorAll(selector)];
      if (matches.length) {
        source = matches.reduce((best, el) => (el.innerText.length > best.innerText.length ? el : best));
        break;
      }
    }
    source ??= document.body;
    const text = source.innerText.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { title: document.title, url: location.href, tag: source.tagName.toLowerCase(), text };
  }

  cf.text = { pageText };
})();
```

`extension/content/form.js`:
```js
(() => {
  if (globalThis.__cf?.form) return;
  const cf = (globalThis.__cf ??= {});
  const NUMERIC = new Set(["number", "range"]);

  const fire = (el, type) => el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));

  function setValue({ ref, value, guard }) {
    const el = cf.tree.resolve(ref);
    cf.dom.guardHost(guard);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const tag = el.tagName.toUpperCase();
    const type = tag === "INPUT" ? el.type : "";
    const sensitive = cf.tree.isSensitive(el);
    const show = (v) => (sensitive ? "[redacted]" : JSON.stringify(String(v)));

    if (tag === "SELECT") return selectOption(el, value);
    if (type === "checkbox") {
      if (typeof value !== "boolean") throw new Error("Checkbox requires a boolean value (true/false)");
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

  function selectOption(el, value) {
    const wanted = String(value);
    const options = [...el.options];
    const option = options.find((o) => o.value === wanted)
      ?? options.find((o) => o.text === wanted)
      ?? options.find((o) => o.text.trim().toLowerCase() === wanted.trim().toLowerCase());
    if (!option) throw new Error(`Option "${wanted}" not found. Available options: ${options.map((o) => `"${o.text.trim()}" (value: "${o.value}")`).join(", ")}`);
    const previous = el.selectedOptions[0]?.text.trim() ?? "";
    el.focus();
    option.selected = true;
    fire(el, "input");
    fire(el, "change");
    return `Selected "${option.text.trim()}" (previous: "${previous}")`;
  }

  cf.form = { setValue };
})();
```

- [ ] **Step 4: Implement guard.js**

`extension/background/guard.js`:
```js
export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export const domainChangedMessage = (action) => `Page navigated to a different domain during ${action}. Re-read the tab state before retrying.`;

export async function assertSameHost(api, tab, action) {
  const now = await api.tabs.get(tab.id);
  if (hostOf(now.url) !== hostOf(tab.url)) throw new Error(domainChangedMessage(action));
}

// Frame 0 checks its own location right before dispatching. Other frames cannot read the
// top-level URL, so the background checks it just before sending them the operation.
export async function guardFor(api, tab, frameId, action) {
  if (frameId === 0) return { host: hostOf(tab.url), action };
  await assertSameHost(api, tab, action);
  return null;
}
```

- [ ] **Step 5: Add get_page_text and form_input to page.js**

In `extension/background/tools/page.js`, replace the import line with:
```js
import { guardFor } from "../guard.js";
import { formatFind, parseRef, renderTree, scoreNodes, truncateAtLine } from "../tree.js";
```
Replace `export function pageTools({ content }) {` with `export function pageTools({ api, content }) {`, and add these two entries after the `find` entry:
```js
    get_page_text: {
      tabScoped: true,
      async run({ tab, args }) {
        const page = await content.call(tab.id, 0, "text.pageText");
        if (page.text.length < 10) return "No text content found. The page may consist mostly of images, video or canvas.";
        const text = truncateAtLine(page.text, args.max_chars ?? 50_000, "Pass a larger max_chars, or use read_page with a ref_id to focus on a smaller section.");
        return `Title: ${page.title}\nURL: ${page.url}\nSource element: <${page.tag}>\n---\n${text}`;
      },
    },
    form_input: {
      tabScoped: true,
      async run({ tab, args }) {
        const { frameId, ref } = parseRef(args.ref);
        const guard = await guardFor(api, tab, frameId, "form_input");
        return content.call(tab.id, frameId, "form.setValue", { ref, value: args.value, guard });
      },
    },
```

In `extension/background/main.js` change `...pageTools({ content }),` to `...pageTools({ api, content }),`.

In `test/unit/page-tools.test.js` the existing calls `pageTools({ content })` keep working, since `api` is only used by `form_input`.

- [ ] **Step 6: Register the content scripts**

In `extension/manifest.json`, change
```json
      "js": ["content/tree.js", "content/router.js"]
```
to
```json
      "js": ["content/dom.js", "content/tree.js", "content/form.js", "content/text.js", "content/router.js"]
```

- [ ] **Step 7: Run the unit tests**

Run: `npm test`
Expected: PASS (72 tests).

- [ ] **Step 8: Add e2e fixtures**

`test/e2e/pages/forms.html`:
```html
<!doctype html><title>Forms</title>
<label for="name">Name</label><input id="name" value="old">
<label for="country">Country</label><select id="country"><option value="us">United States</option><option value="kr">Korea</option></select>
<label><input type="checkbox" id="agree"> I agree</label>
<label><input type="radio" name="size" value="s"> Small</label><label><input type="radio" name="size" value="l"> Large</label>
<label for="qty">Quantity</label><input id="qty" type="number">
<label for="when">Date</label><input id="when" type="date">
<label for="bio">Bio</label><textarea id="bio"></textarea>
<div id="notes" contenteditable="true" aria-label="Notes">draft</div>
<label for="secret">Secret</label><input id="secret" type="password">
<pre id="log"></pre>
<script>
  const log = (m) => { document.getElementById("log").textContent += m + "\n"; };
  const name = document.getElementById("name");
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  let tracked = name.value;
  Object.defineProperty(name, "value", { configurable: true, get() { return native.get.call(this); }, set(v) { tracked = String(v); native.set.call(this, v); } });
  name.addEventListener("input", () => { const now = native.get.call(name); if (now !== tracked) { tracked = now; log("name changed to " + now); } });
  for (const id of ["country", "agree", "qty", "when", "bio"]) {
    document.getElementById(id).addEventListener("change", (e) => log(id + " change " + (e.target.type === "checkbox" ? e.target.checked : e.target.value)));
  }
  document.querySelectorAll("input[name=size]").forEach((r) => r.addEventListener("change", () => log("size " + r.value)));
  document.getElementById("notes").addEventListener("input", () => log("notes input"));
</script>
```

`test/e2e/pages/article.html`:
```html
<!doctype html><title>Article page</title>
<nav>Site navigation: Home · News · About</nav>
<article><h1>Headline</h1><p>First paragraph of the story.</p><p>Second paragraph with more detail.</p></article>
<footer>Copyright footer</footer>
```

- [ ] **Step 9: Append the e2e tests**

Append to `test/e2e/e2e.test.js`:
```js
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
```

- [ ] **Step 10: Run lint and e2e**

Run: `npm run lint && npm run e2e`
Expected: lint `errors 0`; e2e PASS (17 tests).

- [ ] **Step 11: Commit**

```bash
git add extension/content/dom.js extension/content/text.js extension/content/form.js extension/background/guard.js extension/background/tools/page.js extension/background/main.js extension/manifest.json test/unit/form.test.js test/unit/guard.test.js test/e2e/pages/forms.html test/e2e/pages/article.html test/e2e/e2e.test.js
git commit -m "Add form_input, get_page_text and the domain-change guard"
```

---
### Task 10: javascript_tool

**Files:**
- Create: `extension/background/tools/javascript.js`, `test/unit/javascript.test.js`, `test/e2e/pages/csp-page.html`, `test/e2e/pages/csp-page.js`
- Modify: `extension/background/main.js`, `test/e2e/e2e.test.js` (append)

**Interfaces:**
- Consumes: `assertSameHost` (Task 9)
- Produces:
  - `pageProgram(code, { nonce, wrapAsync? }) → string`. This is the `tabs.executeScript` code. It resolves to a JSON string: `{ok:true, value}`, `{ok:false, error}`, or `{ok:false, cspBlocked:true, error}`.
  - `javascriptTool({ api })` → `javascript_tool`

- [ ] **Step 1: Write the failing unit test**

`test/unit/javascript.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { pageProgram } from "../../extension/background/tools/javascript.js";

async function run(code, { wrapAsync = false, blockEval = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="x" class="a b"></div></body>`, { runScripts: "outside-only" });
  if (blockEval) dom.window.eval = () => { throw new dom.window.EvalError("call to eval() blocked by CSP"); };
  return JSON.parse(await vm.runInContext(pageProgram(code, { nonce: "t", wrapAsync }), dom.getInternalVMContext()));
}

test("returns the value of the last expression", async () => {
  assert.deepEqual(await run("const a = 2; a * 21"), { ok: true, value: "42" });
});

test("awaits promises", async () => {
  assert.deepEqual(await run("Promise.resolve(6).then((n) => n * 7)"), { ok: true, value: "42" });
});

test("strings come back raw and objects as indented JSON", async () => {
  assert.equal((await run("'hello'")).value, "hello");
  assert.equal((await run("({ a: [1, 2], b: null })")).value, '{\n  "a": [\n    1,\n    2\n  ],\n  "b": null\n}');
});

test("describes DOM nodes, functions, cycles and long strings", async () => {
  assert.equal((await run("document.getElementById('x')")).value, "<div#x.a.b>");
  assert.equal((await run("(function named() {})")).value, "[Function named]");
  assert.match((await run("const o = {}; o.self = o; o")).value, /"self": "\[Circular\]"/);
  assert.match((await run("'z'.repeat(1500)")).value, /…\[500 more chars\]$/);
});

test("reports thrown errors with their name", async () => {
  const result = await run("nope.value");
  assert.equal(result.ok, false);
  assert.match(result.error, /^ReferenceError: nope is not defined/);
});

test("top-level await fails plainly and works once wrapped", async () => {
  const code = "const x = await Promise.resolve(5); return x * 2";
  const plain = await run(code);
  assert.equal(plain.ok, false);
  assert.match(plain.error, /await is only valid/);
  assert.deepEqual(await run(code, { wrapAsync: true }), { ok: true, value: "10" });
});

test("a CSP-blocked eval is reported so the sandbox fallback can run", async () => {
  const result = await run("1", { blockEval: true });
  assert.equal(result.cspBlocked, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/extension/background/tools/javascript.js'`.

- [ ] **Step 3: Implement javascript.js**

`extension/background/tools/javascript.js`:
```js
import { assertSameHost } from "../guard.js";

const EXEC_TIMEOUT_MS = 25_000;
const MAX_OUTPUT = 51_200;
const WRAPPABLE = /await is only valid|return not in function|Illegal return/i;
const SANDBOX_NOTE = "[ran in extension sandbox: page CSP blocks eval; use window.wrappedJSObject for page globals]\n";
const WRAPPED_NOTE = "[code was wrapped in an async function; use return to produce a value]\n";
const ERROR_TEXT = 'e && e.stack ? e.name + ": " + e.message + "\\n" + String(e.stack).split("\\n").slice(0, 3).join("\\n") : String(e)';

// Injected into the page as source text, so it must not reference anything outside itself.
function serialize(value) {
  const seen = new WeakSet();
  const walk = (v, depth) => {
    if (v === undefined) return "undefined";
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v === "string") return v.length > 1000 ? `${v.slice(0, 1000)}…[${v.length - 1000} more chars]` : v;
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "symbol") return v.toString();
    if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
    if (typeof Node !== "undefined" && v instanceof Node) {
      if (v.nodeType !== 1) return `[${v.nodeName}]`;
      const id = v.id ? `#${v.id}` : "";
      const classes = typeof v.className === "string" && v.className.trim() ? `.${v.className.trim().split(/\s+/).join(".")}` : "";
      return `<${v.tagName.toLowerCase()}${id}${classes}>`;
    }
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (seen.has(v)) return "[Circular]";
    if (depth >= 5) return Array.isArray(v) ? `[Array(${v.length})]` : "[Object]";
    seen.add(v);
    if (Array.isArray(v)) {
      const items = v.slice(0, 100).map((item) => walk(item, depth + 1));
      if (v.length > 100) items.push(`…[${v.length - 100} more items]`);
      return items;
    }
    if (v instanceof Map) return { "[Map]": walk([...v.entries()], depth + 1) };
    if (v instanceof Set) return { "[Set]": walk([...v], depth + 1) };
    const out = {};
    for (const key of Object.keys(v)) {
      try {
        out[key] = walk(v[key], depth + 1);
      } catch (err) {
        out[key] = `[Error: ${err.message}]`;
      }
    }
    return out;
  };
  const result = walk(value, 0);
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

// The page realm hands its result back through a DOM event: a string detail crosses the
// content-script boundary unchanged, which page Promises and objects do not reliably do.
export function pageProgram(code, { nonce, wrapAsync = false }) {
  const body = wrapAsync ? `(async () => {\n${code}\n})()` : code;
  const event = JSON.stringify(`__claude_firefox_js_${nonce}`);
  const inner = [
    "(async () => {",
    `  const serialize = ${serialize.toString()};`,
    "  let outcome;",
    `  try { outcome = { ok: true, value: serialize(await (0, eval)(${JSON.stringify(body)})) }; }`,
    `  catch (e) { outcome = { ok: false, error: ${ERROR_TEXT} }; }`,
    `  document.dispatchEvent(new CustomEvent(${event}, { detail: JSON.stringify(outcome) }));`,
    "})()",
  ].join("\n");
  return [
    "new Promise((resolve) => {",
    `  document.addEventListener(${event}, (e) => resolve(e.detail), { once: true });`,
    `  try { window.eval(${JSON.stringify(inner)}); }`,
    "  catch (e) { resolve(JSON.stringify({ ok: false, cspBlocked: true, error: String(e) })); }",
    "})",
  ].join("\n");
}

async function execute(api, tabId, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`javascript_tool timed out after ${EXEC_TIMEOUT_MS / 1000}s`)), EXEC_TIMEOUT_MS);
  });
  try {
    const [result] = await Promise.race([api.tabs.executeScript(tabId, { frameId: 0, code }), timeout]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

const limit = (text) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[output truncated at ${MAX_OUTPUT} characters]` : text);

async function inPage(api, tabId, code) {
  let outcome = JSON.parse(await execute(api, tabId, pageProgram(code, { nonce: crypto.randomUUID() })));
  if (!outcome.ok && !outcome.cspBlocked && WRAPPABLE.test(outcome.error)) {
    outcome = JSON.parse(await execute(api, tabId, pageProgram(code, { nonce: crypto.randomUUID(), wrapAsync: true })));
    if (outcome.ok) outcome.value = WRAPPED_NOTE + outcome.value;
  }
  return outcome;
}

async function inSandbox(api, tabId, code) {
  try {
    let value;
    try {
      value = await execute(api, tabId, code);
    } catch (err) {
      if (!WRAPPABLE.test(err.message)) throw err;
      value = await execute(api, tabId, `(async () => {\n${code}\n})()`);
    }
    return SANDBOX_NOTE + (value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } catch (err) {
    throw new Error(SANDBOX_NOTE + err.message);
  }
}

export function javascriptTool({ api }) {
  return {
    javascript_tool: {
      tabScoped: true,
      async run({ tab, args }) {
        if (args.action !== "javascript_exec") throw new Error('javascript_tool: action must be "javascript_exec"');
        const code = String(args.text ?? "");
        if (!code.trim()) throw new Error("javascript_tool: text is required");
        await assertSameHost(api, tab, "javascript_tool");
        const outcome = await inPage(api, tab.id, code);
        if (outcome.cspBlocked) return limit(await inSandbox(api, tab.id, code));
        if (!outcome.ok) throw new Error(limit(outcome.error));
        return limit(outcome.value);
      },
    },
  };
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npm test`
Expected: PASS (79 tests).

- [ ] **Step 5: Register the tool**

In `extension/background/main.js` add after the `pageTools` import:
```js
import { javascriptTool } from "./tools/javascript.js";
```
and add `...javascriptTool({ api }),` as the last entry of the `tools` object.

- [ ] **Step 6: Add the CSP fixture and e2e tests**

`test/e2e/pages/csp-page.html` (the fixture server adds `Content-Security-Policy: script-src 'self'` to files named `csp-*`):
```html
<!doctype html><title>CSP page</title><script src="/csp-page.js"></script><p>Strict CSP fixture.</p>
```

`test/e2e/pages/csp-page.js`:
```js
window.pageVar = 42;
```

Append to `test/e2e/e2e.test.js`:
```js
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
```

- [ ] **Step 7: Run lint and e2e**

Run: `npm run lint && npm run e2e`
Expected: lint `errors 0`; e2e PASS (21 tests).

- [ ] **Step 8: Commit**

```bash
git add extension/background/tools/javascript.js extension/background/main.js test/unit/javascript.test.js test/e2e/pages/csp-page.html test/e2e/pages/csp-page.js test/e2e/e2e.test.js
git commit -m "Add javascript_tool with page-realm evaluation and CSP sandbox fallback"
```

---

### Task 11: Synthetic keyboard input

**Files:**
- Create: `extension/content/input.js`, `test/unit/input-keys.test.js`
- Modify: `extension/manifest.json`

**Interfaces:**
- Consumes: `__cf.dom.setNativeValue`, `__cf.dom.isContentEditable`, `__cf.dom.guardHost` (Task 9)
- Produces content `__cf.input`:
  - `viewport() → { width, height, dpr, scrollX, scrollY }`
  - `type({ text, guard }) → {} | { redirect: { frameId } }`
  - `keys({ spec, repeat?, guard }) → {} | { reload: { bypassCache } } | { redirect: { frameId } }`
  - `parseKeySpec(spec) → Array<{ key, code, keyCode, printable, mods: {ctrl, shift, alt, meta} }>`
  - Internal helpers that Task 12 reuses inside the same file: `MODIFIERS`, `FOCUSABLE`, `tagOf`, `supportsSelection`, `scrollFrom`

- [ ] **Step 1: Write the failing tests**

`test/unit/input-keys.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent, plain } from "./helpers/dom.js";

const FILES = ["dom.js", "tree.js", "input.js"];
const focused = (html, selector = "input, textarea") => {
  const w = loadContent(html, FILES);
  const el = w.document.querySelector(selector);
  el.focus();
  return { w, el };
};

test("key specs parse names, xdotool aliases and chords", () => {
  const w = loadContent("", FILES);
  const parse = (spec) => w.__cf.input.parseKeySpec(spec).map((c) => ({ key: c.key, code: c.code, mods: Object.keys(c.mods).filter((m) => c.mods[m]).join("+") }));
  assert.deepEqual(parse("Enter"), [{ key: "Enter", code: "Enter", mods: "" }]);
  assert.deepEqual(parse("cmd+a shift+Tab"), [{ key: "a", code: "KeyA", mods: "meta" }, { key: "Tab", code: "Tab", mods: "shift" }]);
  assert.deepEqual(parse("Page_Down BackSpace KP_Enter"), [{ key: "PageDown", code: "PageDown", mods: "" }, { key: "Backspace", code: "Backspace", mods: "" }, { key: "Enter", code: "NumpadEnter", mods: "" }]);
  assert.deepEqual(parse("ctrl+shift+r"), [{ key: "R", code: "KeyR", mods: "ctrl+shift" }]);
  assert.deepEqual(parse("cmd++ +"), [{ key: "+", code: "Equal", mods: "shift+meta" }, { key: "+", code: "Equal", mods: "shift" }]);
  assert.deepEqual(parse("F5"), [{ key: "F5", code: "F5", mods: "" }]);
  assert.throws(() => parse("Hyperspace"), /Unknown key: Hyperspace/);
  assert.throws(() => parse("hyper+a"), /Unknown modifier "hyper" in "hyper\+a"/);
});

test("zoom chords are refused and reload chords are handed back to the background", () => {
  const w = loadContent("", FILES);
  assert.throws(() => w.__cf.input.keys({ spec: "cmd+=" }), /zoom/);
  assert.deepEqual(plain(w.__cf.input.keys({ spec: "cmd+r" })), { reload: { bypassCache: false } });
  assert.deepEqual(plain(w.__cf.input.keys({ spec: "cmd+shift+r" })), { reload: { bypassCache: true } });
});

test("type fires key events per character and inserts text through the value-setter fallback", () => {
  const { w, el } = focused(`<input id="q">`);
  const keydowns = [];
  const inputs = [];
  el.addEventListener("keydown", (e) => keydowns.push(e.key));
  el.addEventListener("input", (e) => inputs.push(e.data));
  w.__cf.input.type({ text: "hé👋" });
  assert.equal(el.value, "hé👋");
  assert.deepEqual(keydowns, ["h", "é", "👋"]);
  assert.deepEqual(inputs, ["h", "é", "👋"]);
});

test("type refuses when nothing editable has focus", () => {
  const w = loadContent(`<button>Plain</button>`, FILES);
  assert.throws(() => w.__cf.input.type({ text: "x" }), /No editable element is focused \(focus is on <body>\)/);
});

test("a cancelled keydown suppresses the default action", () => {
  const { w, el } = focused(`<input>`);
  el.addEventListener("keydown", (e) => e.preventDefault());
  w.__cf.input.type({ text: "abc" });
  assert.equal(el.value, "");
});

test("Enter in a text field submits through the form's default button", () => {
  const { w } = focused(`<form><input name="q"><button>Go</button></form>`);
  let clicks = 0;
  let submits = 0;
  w.document.querySelector("button").addEventListener("click", () => clicks++);
  w.document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  w.__cf.input.keys({ spec: "Enter" });
  assert.equal(clicks, 1);
  assert.equal(submits, 1);
});

test("Tab and shift+Tab follow tab order, skipping disabled and negative tabindex", () => {
  const w = loadContent(`<input id="a"><input id="b" disabled><button id="c" tabindex="-1">C</button><a id="d" href="#">D</a><input id="e">`, FILES);
  w.document.getElementById("a").focus();
  w.__cf.input.keys({ spec: "Tab" });
  assert.equal(w.document.activeElement.id, "d");
  w.__cf.input.keys({ spec: "Tab" });
  assert.equal(w.document.activeElement.id, "e");
  w.__cf.input.keys({ spec: "shift+Tab" });
  assert.equal(w.document.activeElement.id, "d");
});

test("Backspace, Delete, Home, shift+arrows and cmd+a edit text fields", () => {
  const { w, el } = focused(`<input value="hello">`);
  el.setSelectionRange(5, 5);
  w.__cf.input.keys({ spec: "BackSpace" });
  assert.equal(el.value, "hell");
  w.__cf.input.keys({ spec: "Home Delete" });
  assert.equal(el.value, "ell");
  w.__cf.input.keys({ spec: "shift+Right shift+Right" });
  assert.deepEqual([el.selectionStart, el.selectionEnd], [0, 2]);
  w.__cf.input.keys({ spec: "cmd+a" });
  assert.deepEqual([el.selectionStart, el.selectionEnd], [0, 3]);
});

test("Space toggles a focused checkbox and newlines type into textareas", () => {
  const w = loadContent(`<input type="checkbox" id="c"><textarea id="t"></textarea>`, FILES);
  const box = w.document.getElementById("c");
  box.focus();
  w.__cf.input.keys({ spec: "space" });
  assert.equal(box.checked, true);
  const area = w.document.getElementById("t");
  area.focus();
  w.__cf.input.type({ text: "a\nb" });
  assert.equal(area.value, "a\nb");
});

test("the domain guard blocks typing once the page changed host", () => {
  const w = loadContent(`<input>`, FILES, { url: "https://evil.test/" });
  w.document.querySelector("input").focus();
  assert.throws(() => w.__cf.input.type({ text: "x", guard: { host: "good.test", action: "type" } }), /different domain during type/);
  assert.equal(w.document.querySelector("input").value, "");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `ENOENT … extension/content/input.js`.

- [ ] **Step 3: Implement the keyboard half of input.js**

`extension/content/input.js`:
```js
(() => {
  if (globalThis.__cf?.input) return;
  const cf = (globalThis.__cf ??= {});

  const MODIFIERS = { ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", option: "alt", cmd: "meta", meta: "meta", command: "meta", super: "meta", win: "meta", windows: "meta" };
  // [key, code, keyCode] using Firefox's keyCodes (Meta 224, "-" 173, "=" 61, ";" 59).
  const NAMED_KEYS = {
    enter: ["Enter", "Enter", 13], return: ["Enter", "Enter", 13], kpenter: ["Enter", "NumpadEnter", 13],
    tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46],
    space: [" ", "Space", 32], insert: ["Insert", "Insert", 45],
    up: ["ArrowUp", "ArrowUp", 38], arrowup: ["ArrowUp", "ArrowUp", 38], down: ["ArrowDown", "ArrowDown", 40], arrowdown: ["ArrowDown", "ArrowDown", 40],
    left: ["ArrowLeft", "ArrowLeft", 37], arrowleft: ["ArrowLeft", "ArrowLeft", 37], right: ["ArrowRight", "ArrowRight", 39], arrowright: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36], end: ["End", "End", 35],
    pageup: ["PageUp", "PageUp", 33], prior: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34], next: ["PageDown", "PageDown", 34],
    shift: ["Shift", "ShiftLeft", 16], ctrl: ["Control", "ControlLeft", 17], control: ["Control", "ControlLeft", 17],
    alt: ["Alt", "AltLeft", 18], option: ["Alt", "AltLeft", 18],
    cmd: ["Meta", "MetaLeft", 224], meta: ["Meta", "MetaLeft", 224], command: ["Meta", "MetaLeft", 224], super: ["Meta", "MetaLeft", 224],
    minus: ["-", "Minus", 173], plus: ["+", "Equal", 61], equal: ["=", "Equal", 61], comma: [",", "Comma", 188], period: [".", "Period", 190],
    slash: ["/", "Slash", 191], backslash: ["\\", "Backslash", 220], semicolon: [";", "Semicolon", 59], apostrophe: ["'", "Quote", 222],
    quote: ["'", "Quote", 222], grave: ["`", "Backquote", 192], bracketleft: ["[", "BracketLeft", 219], bracketright: ["]", "BracketRight", 221],
  };
  // [code, keyCode, needs shift]
  const PUNCTUATION = {
    "-": ["Minus", 173], "=": ["Equal", 61], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 59],
    "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
    "_": ["Minus", 173, true], "+": ["Equal", 61, true], "{": ["BracketLeft", 219, true], "}": ["BracketRight", 221, true], "|": ["Backslash", 220, true],
    ":": ["Semicolon", 59, true], '"': ["Quote", 222, true], "<": ["Comma", 188, true], ">": ["Period", 190, true], "?": ["Slash", 191, true], "~": ["Backquote", 192, true],
    "!": ["Digit1", 49, true], "@": ["Digit2", 50, true], "#": ["Digit3", 51, true], "$": ["Digit4", 52, true], "%": ["Digit5", 53, true],
    "^": ["Digit6", 54, true], "&": ["Digit7", 55, true], "*": ["Digit8", 56, true], "(": ["Digit9", 57, true], ")": ["Digit0", 48, true],
  };
  const TEXT_SELECTION_TYPES = new Set(["text", "search", "url", "tel", "password"]);
  const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden", "range", "color"]);
  const ACTIVATABLE_INPUTS = new Set(["checkbox", "radio", "submit", "button", "reset", "image"]);
  const ACTIVATABLE_ROLES = new Set(["button", "checkbox", "switch", "radio"]);
  const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable="true"]';

  const tagOf = (el) => el.tagName.toUpperCase();
  const isTextField = (el) => tagOf(el) === "TEXTAREA" || (tagOf(el) === "INPUT" && !NON_TEXT_INPUTS.has(el.type));
  const supportsSelection = (el) => tagOf(el) === "TEXTAREA" || (tagOf(el) === "INPUT" && TEXT_SELECTION_TYPES.has(el.type));
  const isEditable = (el) => isTextField(el) || cf.dom.isContentEditable(el);
  const describeElement = (el) => `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}>`;

  function keyForChar(ch) {
    if (/^[a-z]$/i.test(ch)) {
      const upper = ch.toUpperCase();
      return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), printable: true, shift: ch !== ch.toLowerCase() };
    }
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), printable: true, shift: false };
    if (ch === " ") return { key: " ", code: "Space", keyCode: 32, printable: true, shift: false };
    const punct = PUNCTUATION[ch];
    if (punct) return { key: ch, code: punct[0], keyCode: punct[1], printable: true, shift: !!punct[2] };
    return { key: ch, code: "", keyCode: 0, printable: true, shift: false };
  }

  function keyForName(name) {
    if ([...name].length === 1) return keyForChar(name);
    const fn = /^f([1-9]|1[0-2])$/i.exec(name);
    if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]), printable: false, shift: false };
    const named = NAMED_KEYS[name.toLowerCase().replace(/_/g, "")];
    if (!named) throw new Error(`Unknown key: ${name}`);
    return { key: named[0], code: named[1], keyCode: named[2], printable: named[0].length === 1, shift: false };
  }

  function parseChord(token) {
    const plusKey = token.endsWith("+");
    const parts = plusKey ? token.slice(0, -1).split("+").filter(Boolean) : token.split("+");
    const keyName = plusKey ? "+" : parts.pop();
    const mods = { ctrl: false, shift: false, alt: false, meta: false };
    for (const part of parts) {
      const mod = MODIFIERS[part.toLowerCase()];
      if (!mod) throw new Error(`Unknown modifier "${part}" in "${token}"`);
      mods[mod] = true;
    }
    if (!keyName) throw new Error(`Missing key in "${token}"`);
    const key = keyForName(keyName);
    if (mods.shift && /^[a-z]$/.test(key.key)) key.key = key.key.toUpperCase();
    return { key: key.key, code: key.code, keyCode: key.keyCode, printable: key.printable, mods: { ...mods, shift: mods.shift || key.shift } };
  }

  function parseKeySpec(spec) {
    const tokens = String(spec ?? "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) throw new Error("No keys given");
    return tokens.map(parseChord);
  }

  const charChord = (ch) => {
    const key = keyForChar(ch);
    return { key: key.key, code: key.code, keyCode: key.keyCode, printable: true, mods: { ctrl: false, shift: key.shift, alt: false, meta: false } };
  };
  const isZoomChord = (c) => (c.mods.ctrl || c.mods.meta) && ["=", "+", "-", "0"].includes(c.key);
  const isReloadChord = (c) => c.key === "F5" || ((c.mods.ctrl || c.mods.meta) && c.key.toLowerCase() === "r");

  function activeTarget() {
    let el = document.activeElement ?? document.body ?? document.documentElement;
    for (;;) {
      const tag = tagOf(el);
      if (tag === "IFRAME" || tag === "FRAME") {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (!doc) return { redirect: { frameId: browser.runtime.getFrameId(el) } };
        el = doc.activeElement ?? doc.body;
        continue;
      }
      const root = el.openOrClosedShadowRoot ?? el.shadowRoot;
      if (root?.activeElement) {
        el = root.activeElement;
        continue;
      }
      return { el };
    }
  }

  function keyInit(c) {
    return { key: c.key, code: c.code, keyCode: c.keyCode, which: c.keyCode, ctrlKey: c.mods.ctrl, shiftKey: c.mods.shift, altKey: c.mods.alt, metaKey: c.mods.meta, bubbles: true, cancelable: true, composed: true };
  }

  function pressChord(c) {
    const { el } = activeTarget();
    const win = el.ownerDocument.defaultView;
    const init = keyInit(c);
    let proceed = el.dispatchEvent(new win.KeyboardEvent("keydown", init));
    if (proceed && c.printable && !c.mods.ctrl && !c.mods.meta) proceed = el.dispatchEvent(new win.KeyboardEvent("keypress", { ...init, charCode: c.key.codePointAt(0), keyCode: 0 }));
    if (proceed) defaultAction(el, c);
    const after = activeTarget().el ?? el;
    after.dispatchEvent(new after.ownerDocument.defaultView.KeyboardEvent("keyup", init));
  }

  function defaultAction(el, c) {
    const doc = el.ownerDocument;
    if (c.mods.ctrl || c.mods.meta) {
      switch (c.key.toLowerCase()) {
        case "a": if (supportsSelection(el)) el.select(); else doc.execCommand("selectAll"); return;
        case "c": doc.execCommand("copy"); return;
        case "x": doc.execCommand("cut"); return;
        case "z": doc.execCommand(c.mods.shift ? "redo" : "undo"); return;
        case "y": doc.execCommand("redo"); return;
        default: return;
      }
    }
    switch (c.key) {
      case "Enter":
        pressEnter(el, c.mods.shift);
        return;
      case "Tab":
        moveFocus(el, c.mods.shift ? -1 : 1);
        return;
      case "Backspace":
        if (isEditable(el) && !doc.execCommand("delete")) deleteInField(el, -1);
        return;
      case "Delete":
        if (isEditable(el) && !doc.execCommand("forwardDelete")) deleteInField(el, 1);
        return;
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        if (isEditable(el)) moveCaret(el, c.key, c.mods.shift);
        else scrollByKey(el, c.key);
        return;
      case "ArrowUp":
      case "ArrowDown":
        if (cf.dom.isContentEditable(el)) doc.getSelection().modify(c.mods.shift ? "extend" : "move", c.key === "ArrowUp" ? "backward" : "forward", "line");
        else if (!isEditable(el)) scrollByKey(el, c.key);
        return;
      case "PageUp":
      case "PageDown":
        scrollByKey(el, c.key);
        return;
      case " ":
        if (isEditable(el)) break;
        if (isActivatable(el)) el.click();
        else scrollByKey(el, c.mods.shift ? "PageUp" : "PageDown");
        return;
      default:
        break;
    }
    if (c.printable && isEditable(el)) insertText(el, c.key);
  }

  function isActivatable(el) {
    const tag = tagOf(el);
    return tag === "BUTTON" || tag === "SUMMARY" || (tag === "INPUT" && ACTIVATABLE_INPUTS.has(el.type)) || ACTIVATABLE_ROLES.has(el.getAttribute("role"));
  }

  function insertText(el, text) {
    const doc = el.ownerDocument;
    if (doc.execCommand("insertText", false, text)) return;
    if (!isTextField(el)) return;
    const length = el.value.length;
    const start = supportsSelection(el) ? el.selectionStart : length;
    const end = supportsSelection(el) ? el.selectionEnd : length;
    cf.dom.setNativeValue(el, el.value.slice(0, start) + text + el.value.slice(end));
    if (supportsSelection(el)) el.setSelectionRange(start + text.length, start + text.length);
    el.dispatchEvent(new doc.defaultView.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function deleteInField(el, direction) {
    if (!isTextField(el)) return;
    const length = el.value.length;
    let start = supportsSelection(el) ? el.selectionStart : length;
    let end = supportsSelection(el) ? el.selectionEnd : length;
    if (start === end) {
      if (direction < 0 && start > 0) start--;
      else if (direction > 0 && end < length) end++;
      else return;
    }
    cf.dom.setNativeValue(el, el.value.slice(0, start) + el.value.slice(end));
    if (supportsSelection(el)) el.setSelectionRange(start, start);
    el.dispatchEvent(new el.ownerDocument.defaultView.InputEvent("input", { bubbles: true, inputType: direction < 0 ? "deleteContentBackward" : "deleteContentForward" }));
  }

  function pressEnter(el, shift) {
    const tag = tagOf(el);
    if (tag === "TEXTAREA") {
      insertText(el, "\n");
      return;
    }
    if (cf.dom.isContentEditable(el)) {
      el.ownerDocument.execCommand(shift ? "insertLineBreak" : "insertParagraph");
      return;
    }
    if (tag === "INPUT" && isTextField(el)) {
      if (el.form) submitImplicitly(el.form);
      return;
    }
    if (tag === "A" || tag === "BUTTON" || tag === "SUMMARY" || el.getAttribute("role") === "button" || (tag === "INPUT" && ["submit", "button", "reset", "image"].includes(el.type))) el.click();
  }

  function submitImplicitly(form) {
    const button = [...form.elements].find((e) => (tagOf(e) === "BUTTON" && e.type === "submit") || (tagOf(e) === "INPUT" && (e.type === "submit" || e.type === "image")));
    if (button) {
      if (!button.disabled) button.click();
      return;
    }
    form.requestSubmit();
  }

  function moveFocus(el, direction) {
    const doc = el.ownerDocument;
    const candidates = [...doc.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && n.tabIndex >= 0 && !(tagOf(n) === "INPUT" && n.type === "hidden") && n.checkVisibility());
    const order = [...candidates.filter((n) => n.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex), ...candidates.filter((n) => n.tabIndex === 0)];
    if (!order.length) return;
    const index = order.indexOf(el);
    const next = index === -1 ? order[direction > 0 ? 0 : order.length - 1] : order[(index + direction + order.length) % order.length];
    next.focus();
    if (supportsSelection(next)) next.select();
  }

  function moveCaret(el, key, shift) {
    if (cf.dom.isContentEditable(el)) {
      const direction = key === "ArrowLeft" || key === "Home" ? "backward" : "forward";
      el.ownerDocument.getSelection().modify(shift ? "extend" : "move", direction, key === "Home" || key === "End" ? "lineboundary" : "character");
      return;
    }
    if (!supportsSelection(el)) return;
    const length = el.value.length;
    const backward = el.selectionDirection === "backward";
    const anchor = backward ? el.selectionEnd : el.selectionStart;
    const focus = backward ? el.selectionStart : el.selectionEnd;
    const collapsed = el.selectionStart === el.selectionEnd;
    let target = { ArrowLeft: focus - 1, ArrowRight: focus + 1, Home: 0, End: length }[key];
    if (!shift && !collapsed && key === "ArrowLeft") target = el.selectionStart;
    if (!shift && !collapsed && key === "ArrowRight") target = el.selectionEnd;
    target = Math.max(0, Math.min(length, target));
    if (!shift) el.setSelectionRange(target, target);
    else if (target < anchor) el.setSelectionRange(target, anchor, "backward");
    else el.setSelectionRange(anchor, target, "forward");
  }

  function canScroll(node, dx, dy) {
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    const scrollable = (overflow) => overflow === "auto" || overflow === "scroll" || overflow === "overlay";
    if (dy && scrollable(style.overflowY)) return dy > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0;
    if (dx && scrollable(style.overflowX)) return dx > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0;
    return false;
  }

  function scrollFrom(el, dx, dy) {
    const doc = el.ownerDocument;
    for (let node = el; node && node !== doc.documentElement && node !== doc.body; node = node.parentElement ?? node.getRootNode().host) {
      if (canScroll(node, dx, dy)) {
        node.scrollBy({ left: dx, top: dy, behavior: "instant" });
        return;
      }
    }
    doc.defaultView.scrollBy({ left: dx, top: dy, behavior: "instant" });
  }

  function scrollByKey(el, key) {
    const page = el.ownerDocument.defaultView.innerHeight * 0.875;
    const deltas = { ArrowUp: [0, -40], ArrowDown: [0, 40], ArrowLeft: [-40, 0], ArrowRight: [40, 0], PageUp: [0, -page], PageDown: [0, page], Home: [0, -1e7], End: [0, 1e7] };
    const [dx, dy] = deltas[key];
    scrollFrom(el, dx, dy);
  }

  function viewport() {
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY };
  }

  function type({ text, guard = null }) {
    const target = activeTarget();
    if (target.redirect) return target;
    cf.dom.guardHost(guard);
    if (!isEditable(target.el)) throw new Error(`No editable element is focused (focus is on ${describeElement(target.el)}). Click the field first.`);
    for (const ch of String(text)) {
      if (ch === "\r") continue;
      pressChord(ch === "\n" ? parseChord("Enter") : charChord(ch));
    }
    return {};
  }

  function keys({ spec, repeat = 1, guard = null }) {
    const chords = parseKeySpec(spec);
    if (chords.some(isZoomChord)) throw new Error("Page zoom shortcuts are not supported. Use the zoom action to magnify a region.");
    if (chords.length === 1 && isReloadChord(chords[0])) return { reload: { bypassCache: chords[0].mods.shift } };
    const target = activeTarget();
    if (target.redirect) return target;
    cf.dom.guardHost(guard);
    for (let i = 0; i < repeat; i++) for (const chord of chords) pressChord(chord);
    return {};
  }

  cf.input = { viewport, type, keys, parseKeySpec };
})();
```

- [ ] **Step 4: Register the content script**

In `extension/manifest.json`, change
```json
      "js": ["content/dom.js", "content/tree.js", "content/form.js", "content/text.js", "content/router.js"]
```
to
```json
      "js": ["content/dom.js", "content/tree.js", "content/form.js", "content/text.js", "content/input.js", "content/router.js"]
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (89 tests).

- [ ] **Step 6: Commit**

```bash
git add extension/content/input.js extension/manifest.json test/unit/input-keys.test.js
git commit -m "Add synthetic keyboard input with default-action emulation"
```

---

### Task 12: Synthetic pointer input

**Files:**
- Modify: `extension/content/input.js`
- Test: `test/unit/input-pointer.test.js`

**Interfaces:**
- Consumes: Task 11 internals (`MODIFIERS`, `FOCUSABLE`, `tagOf`, `supportsSelection`, `scrollFrom`, `cf.dom`); `__cf.tree.resolve` (Task 7)
- Produces, added to content `__cf.input`:
  - `click({ x?, y?, ref?, button?: "left"|"right"|"middle", count?: 1|2|3, modifiers?, guard }) → { opened: string[], point: {x, y} } | { redirect: { frameId, x, y } }`
  - `hover({ x?, y?, ref? }) → { point } | { redirect }`
  - `scroll({ x?, y?, ref?, dx, dy, guard }) → { point } | { redirect }`
  - `scrollTo({ ref }) → {}`
  - `drag({ fromX, fromY, toX, toY, guard }) → { point }`, which throws inside cross-origin frames
  - Coordinates are CSS pixels in the receiving frame's viewport. `point` is in top-frame viewport coordinates and is used for the phantom cursor.

- [ ] **Step 1: Write the failing tests**

`test/unit/input-pointer.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent, plain, stubElementFromPoint, stubLayout } from "./helpers/dom.js";

const FILES = ["dom.js", "tree.js", "input.js"];
const TYPES = ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "contextmenu", "auxclick"];
const setup = (html, options) => {
  const w = loadContent(html, FILES, options);
  stubLayout(w);
  return w;
};
const recorder = (el) => {
  const seen = [];
  for (const type of TYPES) el.addEventListener(type, () => seen.push(type));
  return seen;
};
const refOf = (w, name) => w.__cf.tree.build().nodes.find((n) => n.name === name && n.role !== "label").ref;

test("a ref click dispatches the full pointer sequence, focuses the control and reports the point", () => {
  const w = setup(`<label for="q">Query</label><input id="q">`);
  const input = w.document.getElementById("q");
  const seen = recorder(input);
  const result = w.__cf.input.click({ ref: refOf(w, "Query") });
  assert.deepEqual(seen, ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  assert.equal(w.document.activeElement, input);
  assert.deepEqual(plain(result), { opened: [], point: { x: 60, y: 20 } });
});

test("double clicks carry click counts and right clicks open the context menu without clicking", () => {
  const w = setup(`<button>Target</button>`);
  const button = w.document.querySelector("button");
  const seen = recorder(button);
  const details = [];
  button.addEventListener("click", (e) => details.push(e.detail));
  w.__cf.input.click({ ref: refOf(w, "Target"), count: 2 });
  assert.deepEqual(details, [1, 2]);
  assert.ok(seen.includes("dblclick"));
  seen.length = 0;
  w.__cf.input.click({ ref: refOf(w, "Target"), button: "right" });
  assert.ok(seen.includes("contextmenu"));
  assert.ok(!seen.includes("click"));
});

test("coordinate clicks reach the element under the point inside open shadow roots", () => {
  const w = setup(`<div id="host"></div>`);
  const host = w.document.getElementById("host");
  const inner = w.document.createElement("button");
  host.attachShadow({ mode: "open" }).append(inner);
  stubElementFromPoint(w, () => host);
  w.ShadowRoot.prototype.elementFromPoint = function elementFromPoint() { return inner; };
  let clicks = 0;
  inner.addEventListener("click", () => clicks++);
  w.__cf.input.click({ x: 50, y: 50 });
  assert.equal(clicks, 1);
});

test("modifiers are carried, new-tab links are intercepted and unknown modifiers rejected", () => {
  const w = setup(`<a href="/next" target="_blank">Open</a><a href="/same">Same</a>`);
  const metas = [];
  w.document.addEventListener("click", (e) => metas.push(e.metaKey));
  assert.deepEqual(plain(w.__cf.input.click({ ref: refOf(w, "Open") })).opened, ["https://example.test/next"]);
  assert.deepEqual(plain(w.__cf.input.click({ ref: refOf(w, "Same"), modifiers: "cmd" })).opened, ["https://example.test/same"]);
  assert.deepEqual(metas, [false, true]);
  assert.throws(() => w.__cf.input.click({ ref: refOf(w, "Same"), modifiers: "hyper" }), /Unknown modifier: hyper/);
});

test("hover enters the new target and leaves the previous one", () => {
  const w = setup(`<button>One</button><button>Two</button>`);
  const [one] = w.document.querySelectorAll("button");
  const seenOne = recorder(one);
  const outs = [];
  one.addEventListener("mouseout", () => outs.push("out"));
  w.__cf.input.hover({ ref: refOf(w, "One") });
  w.__cf.input.hover({ ref: refOf(w, "Two") });
  assert.ok(seenOne.includes("mouseover"));
  assert.deepEqual(outs, ["out"]);
});

test("scroll moves the nearest scrollable ancestor unless the wheel event is cancelled", () => {
  const w = setup(`<div id="box" style="overflow-y:auto"><p id="p">content</p></div>`);
  const box = w.document.getElementById("box");
  Object.defineProperties(box, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  const scrolled = [];
  box.scrollBy = (options) => scrolled.push(options.top);
  stubElementFromPoint(w, () => w.document.getElementById("p"));
  w.__cf.input.scroll({ x: 10, y: 10, dx: 0, dy: 300 });
  assert.deepEqual(scrolled, [300]);
  box.addEventListener("wheel", (e) => e.preventDefault());
  w.__cf.input.scroll({ x: 10, y: 10, dx: 0, dy: 300 });
  assert.deepEqual(scrolled, [300]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `w.__cf.input.click is not a function` (and the same for hover and scroll).

- [ ] **Step 3: Add the pointer half to input.js**

In `extension/content/input.js`, replace the final export line
```js
  cf.input = { viewport, type, keys, parseKeySpec };
```
with:
```js
  const BUTTONS = { left: [0, 1], middle: [1, 4], right: [2, 2] };
  const NON_BUBBLING = new Set(["mouseenter", "mouseleave", "pointerenter", "pointerleave"]);
  const hovered = new WeakMap();

  function fire(el, type, x, y, extra = {}) {
    const win = el.ownerDocument.defaultView;
    const Ctor = type.startsWith("pointer") ? win.PointerEvent
      : type === "wheel" ? win.WheelEvent
        : type.startsWith("drag") || type === "drop" ? win.DragEvent
          : win.MouseEvent;
    const bubbles = !NON_BUBBLING.has(type);
    return el.dispatchEvent(new Ctor(type, {
      bubbles, cancelable: bubbles, composed: true, view: win,
      clientX: x, clientY: y, screenX: win.screenX + x, screenY: win.screenY + y,
      pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra,
    }));
  }

  function modifierFlags(spec) {
    const flags = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    for (const part of String(spec ?? "").split("+").filter(Boolean)) {
      const mod = MODIFIERS[part.toLowerCase()];
      if (!mod) throw new Error(`Unknown modifier: ${part}`);
      flags[`${mod}Key`] = true;
    }
    return flags;
  }

  function locate({ x, y, ref }) {
    if (ref) {
      const el = cf.tree.resolve(ref);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      return { el, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    let doc = document;
    let lx = x;
    let ly = y;
    for (;;) {
      let el = doc.elementFromPoint(lx, ly);
      if (!el) throw new Error(`No element at (${Math.round(x)}, ${Math.round(y)}). The point may be outside the page.`);
      for (let root = el.openOrClosedShadowRoot ?? el.shadowRoot; root; root = el.openOrClosedShadowRoot ?? el.shadowRoot) {
        const inner = root.elementFromPoint(lx, ly);
        if (!inner || inner === el) break;
        el = inner;
      }
      const tag = tagOf(el);
      if (tag !== "IFRAME" && tag !== "FRAME") return { el, x: lx, y: ly };
      const rect = el.getBoundingClientRect();
      lx -= rect.left + el.clientLeft;
      ly -= rect.top + el.clientTop;
      let inner = null;
      try {
        inner = el.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) return { redirect: { frameId: browser.runtime.getFrameId(el), x: lx, y: ly } };
      doc = inner;
    }
  }

  function topPoint(el, x, y) {
    let win = el.ownerDocument.defaultView;
    let px = x;
    let py = y;
    while (win !== window && win.frameElement) {
      const rect = win.frameElement.getBoundingClientRect();
      px += rect.left + win.frameElement.clientLeft;
      py += rect.top + win.frameElement.clientTop;
      win = win.parent;
    }
    return { x: px, y: py };
  }

  function hoverTo(el, x, y, flags = {}) {
    const doc = el.ownerDocument;
    const previous = hovered.get(doc)?.deref();
    if (previous && previous !== el && previous.isConnected) {
      for (const type of ["pointerout", "pointerleave", "mouseout", "mouseleave"]) fire(previous, type, x, y, { ...flags, relatedTarget: el });
    }
    if (previous !== el) {
      for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter"]) fire(el, type, x, y, { ...flags, relatedTarget: previous ?? null });
    }
    fire(el, "pointermove", x, y, flags);
    fire(el, "mousemove", x, y, flags);
    hovered.set(doc, new WeakRef(el));
  }

  function focusFor(el, x, y) {
    const doc = el.ownerDocument;
    const target = el.closest(FOCUSABLE);
    if (!target || target.disabled) {
      doc.activeElement?.blur?.();
      return;
    }
    if (doc.activeElement === target) return;
    target.focus();
    if (supportsSelection(target)) target.setSelectionRange(target.value.length, target.value.length);
    else if (cf.dom.isContentEditable(target)) {
      const caret = doc.caretPositionFromPoint(x, y);
      if (caret) doc.getSelection().collapse(caret.offsetNode, caret.offset);
    }
  }

  function selectBlock(el) {
    if (supportsSelection(el)) {
      el.select();
      return;
    }
    const block = el.closest("p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,div") ?? el;
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(block);
    const selection = el.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // A synthetic click on a target=_blank link would be popup-blocked, so new-tab links are
  // cancelled here and opened by the background inside the session's tab group.
  function watchNewTabLinks(win, flags) {
    const urls = [];
    const onClick = (event) => {
      if (event.defaultPrevented) return;
      const link = event.composedPath().find((n) => (n.tagName === "A" || n.tagName === "AREA") && n.hasAttribute("href"));
      if (!link) return;
      const target = (link.getAttribute("target") || "").toLowerCase();
      const newTab = event.type === "auxclick" || flags.ctrlKey || flags.metaKey || (target !== "" && !["_self", "_parent", "_top"].includes(target));
      if (!newTab) return;
      event.preventDefault();
      urls.push(link.href);
    };
    win.addEventListener("click", onClick);
    win.addEventListener("auxclick", onClick);
    return {
      urls,
      stop() {
        win.removeEventListener("click", onClick);
        win.removeEventListener("auxclick", onClick);
      },
    };
  }

  function click({ x, y, ref, button = "left", count = 1, modifiers = "", guard = null }) {
    const at = locate({ x, y, ref });
    if (at.redirect) return at;
    cf.dom.guardHost(guard);
    const { el } = at;
    const flags = modifierFlags(modifiers);
    const [buttonIndex, buttonsMask] = BUTTONS[button];
    const links = watchNewTabLinks(el.ownerDocument.defaultView, flags);
    try {
      hoverTo(el, at.x, at.y, flags);
      for (let i = 1; i <= count; i++) {
        fire(el, "pointerdown", at.x, at.y, { ...flags, button: buttonIndex, buttons: buttonsMask, detail: i });
        const notCancelled = fire(el, "mousedown", at.x, at.y, { ...flags, button: buttonIndex, buttons: buttonsMask, detail: i });
        if (notCancelled && i === 1) focusFor(el, at.x, at.y);
        fire(el, "pointerup", at.x, at.y, { ...flags, button: buttonIndex, buttons: 0, detail: i });
        fire(el, "mouseup", at.x, at.y, { ...flags, button: buttonIndex, buttons: 0, detail: i });
        if (button === "left") fire(el, "click", at.x, at.y, { ...flags, button: 0, buttons: 0, detail: i });
        else if (button === "middle") fire(el, "auxclick", at.x, at.y, { ...flags, button: 1, buttons: 0, detail: i });
        if (button === "left" && i === 2) fire(el, "dblclick", at.x, at.y, { ...flags, button: 0, buttons: 0, detail: 2 });
      }
      if (button === "right") fire(el, "contextmenu", at.x, at.y, { ...flags, button: 2, buttons: 0 });
      if (count === 3) selectBlock(el);
    } finally {
      links.stop();
    }
    return { opened: links.urls, point: topPoint(el, at.x, at.y) };
  }

  function hover({ x, y, ref }) {
    const at = locate({ x, y, ref });
    if (at.redirect) return at;
    hoverTo(at.el, at.x, at.y);
    return { point: topPoint(at.el, at.x, at.y) };
  }

  function scroll({ x, y, ref, dx, dy, guard = null }) {
    const at = locate({ x, y, ref });
    if (at.redirect) return at;
    cf.dom.guardHost(guard);
    if (fire(at.el, "wheel", at.x, at.y, { deltaX: dx, deltaY: dy, deltaMode: 0 })) scrollFrom(at.el, dx, dy);
    return { point: topPoint(at.el, at.x, at.y) };
  }

  function scrollTo({ ref }) {
    cf.tree.resolve(ref).scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return {};
  }

  function drag({ fromX, fromY, toX, toY, guard = null }) {
    const start = locate({ x: fromX, y: fromY });
    if (start.redirect) throw new Error("left_click_drag inside cross-origin frames is not supported");
    cf.dom.guardHost(guard);
    const doc = start.el.ownerDocument;
    const endX = toX + (start.x - fromX);
    const endY = toY + (start.y - fromY);
    hoverTo(start.el, start.x, start.y);
    fire(start.el, "pointerdown", start.x, start.y, { button: 0, buttons: 1 });
    fire(start.el, "mousedown", start.x, start.y, { button: 0, buttons: 1 });
    const source = start.el.closest('[draggable="true"]');
    const data = source ? new doc.defaultView.DataTransfer() : null;
    if (source) fire(source, "dragstart", start.x, start.y, { dataTransfer: data });
    let over = start.el;
    let x = start.x;
    let y = start.y;
    for (let step = 1; step <= 5; step++) {
      x = start.x + ((endX - start.x) * step) / 5;
      y = start.y + ((endY - start.y) * step) / 5;
      const target = doc.elementFromPoint(x, y) ?? over;
      fire(target, "pointermove", x, y, { buttons: 1 });
      fire(target, "mousemove", x, y, { buttons: 1 });
      if (source) {
        fire(source, "drag", x, y, { dataTransfer: data });
        if (target !== over) fire(target, "dragenter", x, y, { dataTransfer: data });
        fire(target, "dragover", x, y, { dataTransfer: data });
      }
      over = target;
    }
    fire(over, "pointerup", x, y, { button: 0, buttons: 0 });
    fire(over, "mouseup", x, y, { button: 0, buttons: 0 });
    if (source) {
      fire(over, "drop", x, y, { dataTransfer: data });
      fire(source, "dragend", x, y, { dataTransfer: data });
    }
    return { point: topPoint(over, x, y) };
  }

  cf.input = { viewport, type, keys, parseKeySpec, click, hover, scroll, scrollTo, drag };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (95 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/content/input.js test/unit/input-pointer.test.js
git commit -m "Add synthetic pointer input: clicks, hover, scroll, drag and new-tab links"
```

---
### Task 13: Screenshot geometry, capture and the page indicator

**Files:**
- Create: `extension/background/geometry.js`, `extension/background/capture.js`, `extension/content/indicator.js`, `test/unit/geometry.test.js`
- Modify: `extension/manifest.json` (add a top-frame-only content-script entry)

**Interfaces:**
- Consumes: content ops `input.viewport` (Task 11), `indicator.*` (this task); `content.call` (Task 6)
- Produces:
  - `targetSize(width, height) → { width, height }`: the largest size with the same aspect ratio where each side is ≤ 1568 and `ceil(w/28)·ceil(h/28)` ≤ 1568
  - `toCssPoint(frame, x, y) → { x, y }`, where `frame = { cssW, cssH, shotW, shotH }`. It throws on out-of-frame or non-numeric input.
  - `createCapture({ api, content })` returns:
    - `screenshot(tabId, { scale? }) → { base64, mimeType: "image/jpeg", width, height, frame: { width, height } }`
    - `zoom(tabId, region, { scale? }) → { base64, mimeType: "image/png", width, height }`
    - `toCss(tabId, [x, y]) → { x, y }`
  - Content `__cf.indicator = { show(), hideSoon(), suspend(), resume(), moveCursor({ x, y }) }` (top frame only)

- [ ] **Step 1: Write the failing test**

`test/unit/geometry.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { targetSize, toCssPoint } from "../../extension/background/geometry.js";

test("viewports within the image budget are left alone", () => {
  assert.deepEqual(targetSize(1280, 720), { width: 1280, height: 720 });
});

test("larger viewports shrink to the largest size within 1568 tiles of 28 px", () => {
  assert.deepEqual(targetSize(1440, 900), { width: 1389, height: 868 });
  const wide = targetSize(3000, 200);
  assert.ok(wide.width <= 1568);
  const big = targetSize(2560, 1440);
  assert.ok(Math.ceil(big.width / 28) * Math.ceil(big.height / 28) <= 1568);
  assert.ok(Math.abs(big.width / big.height - 2560 / 1440) < 0.01);
});

test("screenshot coordinates map back to CSS pixels and are bounds-checked", () => {
  const frame = { cssW: 1440, cssH: 900, shotW: 1389, shotH: 868 };
  assert.deepEqual(toCssPoint(frame, 1389, 868), { x: 1440, y: 900 });
  assert.deepEqual(toCssPoint(frame, 694.5, 434), { x: 720, y: 450 });
  assert.throws(() => toCssPoint(frame, 1400, 10), /outside the 1389x868 screenshot/);
  assert.throws(() => toCssPoint(frame, Number.NaN, 10), /Invalid coordinate/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/extension/background/geometry.js'`.

- [ ] **Step 3: Implement geometry.js**

`extension/background/geometry.js`:
```js
export function targetSize(width, height, { maxSide = 1568, maxTiles = 1568, tile = 28 } = {}) {
  const w0 = Math.max(1, Math.round(width));
  const h0 = Math.max(1, Math.round(height));
  const fits = (w, h) => w <= maxSide && h <= maxSide && Math.ceil(w / tile) * Math.ceil(h / tile) <= maxTiles;
  const heightFor = (w) => Math.max(1, Math.round((w * h0) / w0));
  if (fits(w0, h0)) return { width: w0, height: h0 };
  let lo = 1;
  let hi = w0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid, heightFor(mid))) lo = mid;
    else hi = mid - 1;
  }
  return { width: lo, height: heightFor(lo) };
}

export function toCssPoint(frame, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid coordinate (${x}, ${y})`);
  if (x < 0 || y < 0 || x > frame.shotW || y > frame.shotH) {
    throw new Error(`Coordinate (${x}, ${y}) is outside the ${frame.shotW}x${frame.shotH} screenshot. Take a new screenshot first.`);
  }
  return { x: Math.round((x * frame.cssW) / frame.shotW), y: Math.round((y * frame.cssH) / frame.shotH) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (98 tests).

- [ ] **Step 5: Implement capture.js**

`extension/background/capture.js`. If spike probe Q1c showed a viewport-relative `rect`, drop `+ vp.scrollX` and `+ vp.scrollY` from the zoom rect.
```js
import { targetSize, toCssPoint } from "./geometry.js";

const MAX_BASE64 = 1_398_100;
const clampScale = (scale) => Math.min(1, Math.max(0.1, Number(scale) || 1));
const base64Of = (dataUrl) => dataUrl.slice(dataUrl.indexOf(",") + 1);

export function createCapture({ api, content }) {
  const frames = new Map();

  async function withIndicatorHidden(tabId, fn) {
    await content.call(tabId, 0, "indicator.suspend").catch(() => {});
    try {
      return await fn();
    } finally {
      await content.call(tabId, 0, "indicator.resume").catch(() => {});
    }
  }

  async function captureJpeg(tabId, scale) {
    for (let quality = 75; ; quality -= 10) {
      const dataUrl = await api.tabs.captureTab(tabId, { format: "jpeg", quality, scale });
      if (base64Of(dataUrl).length <= MAX_BASE64 || quality <= 25) return dataUrl;
    }
  }

  async function screenshot(tabId, { scale = 1 } = {}) {
    const vp = await content.call(tabId, 0, "input.viewport");
    const frame = targetSize(vp.width, vp.height);
    const s = clampScale(scale);
    const width = Math.max(1, Math.round(frame.width * s));
    const height = Math.max(1, Math.round(frame.height * s));
    // ImageDetails.scale is relative to CSS pixels, so this renders directly at the target size.
    const dataUrl = await withIndicatorHidden(tabId, () => captureJpeg(tabId, width / vp.width));
    frames.set(tabId, { cssW: vp.width, cssH: vp.height, shotW: frame.width, shotH: frame.height });
    return { base64: base64Of(dataUrl), mimeType: "image/jpeg", width, height, frame };
  }

  function toCss(tabId, [x, y]) {
    const frame = frames.get(tabId);
    return frame ? toCssPoint(frame, Number(x), Number(y)) : { x: Number(x), y: Number(y) };
  }

  async function zoom(tabId, region, { scale = 1 } = {}) {
    const [x0, y0, x1, y1] = region;
    const a = toCss(tabId, [x0, y0]);
    const b = toCss(tabId, [x1, y1]);
    const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    if (rect.width < 1 || rect.height < 1) throw new Error("zoom: region must have a positive width and height");
    const vp = await content.call(tabId, 0, "input.viewport");
    const target = targetSize(rect.width * vp.dpr, rect.height * vp.dpr);
    const s = clampScale(scale);
    const width = Math.max(1, Math.round(target.width * s));
    const height = Math.max(1, Math.round(target.height * s));
    const dataUrl = await withIndicatorHidden(tabId, () => api.tabs.captureTab(tabId, {
      format: "png",
      rect: { x: rect.x + vp.scrollX, y: rect.y + vp.scrollY, width: rect.width, height: rect.height },
      scale: width / rect.width,
    }));
    return { base64: base64Of(dataUrl), mimeType: "image/png", width, height };
  }

  return { screenshot, zoom, toCss };
}
```

- [ ] **Step 6: Implement the indicator content script**

`extension/content/indicator.js` is built with CSSOM and Web Animations rather than a `<style>` element, so strict `style-src` policies cannot block it:
```js
(() => {
  if (window !== window.top || globalThis.__cf?.indicator) return;
  const cf = (globalThis.__cf ??= {});
  const SVG = "http://www.w3.org/2000/svg";
  let host = null;
  let cursor = null;
  let hideTimer = null;
  let visible = false;
  let suspended = false;

  function build() {
    host = document.createElement("claude-firefox-indicator");
    host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; display: none;";
    const root = host.attachShadow({ mode: "closed" });
    const glow = document.createElement("div");
    glow.style.cssText = "position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 15px rgba(217,119,87,.7), inset 0 0 25px rgba(217,119,87,.5), inset 0 0 35px rgba(217,119,87,.2);";
    cursor = document.createElementNS(SVG, "svg");
    cursor.setAttribute("width", "22");
    cursor.setAttribute("height", "22");
    cursor.setAttribute("viewBox", "0 0 24 24");
    cursor.style.cssText = "position: fixed; left: 0; top: 0; transform: translate(-100px, -100px); transition: transform 180ms ease-out; filter: drop-shadow(0 0 3px rgba(217,119,87,.8));";
    const arrow = document.createElementNS(SVG, "path");
    arrow.setAttribute("d", "M3 2 L3 19 L7.5 14.5 L10.5 21 L13 20 L10 13.5 L16.5 13.5 Z");
    arrow.setAttribute("fill", "#FAF9F5");
    arrow.setAttribute("stroke", "#D97757");
    arrow.setAttribute("stroke-width", "1.5");
    arrow.setAttribute("stroke-linejoin", "round");
    cursor.append(arrow);
    root.append(glow, cursor);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      glow.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 1000, direction: "alternate", iterations: Infinity });
    }
  }

  function render() {
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    host.style.display = visible && !suspended ? "block" : "none";
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
    moveCursor({ x, y }) {
      if (!host) build();
      cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    },
  };
})();
```

- [ ] **Step 7: Register the indicator as a top-frame-only content script**

In `extension/manifest.json`, replace the whole `content_scripts` array with the version below, which adds a second, top-frame-only entry. `background/content.js` injects that entry's files only into frame 0.
```json
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "all_frames": true,
      "match_about_blank": true,
      "run_at": "document_start",
      "js": ["content/dom.js", "content/tree.js", "content/form.js", "content/text.js", "content/input.js", "content/router.js"]
    },
    {
      "matches": ["<all_urls>"],
      "run_at": "document_idle",
      "js": ["content/indicator.js"]
    }
  ]
```

- [ ] **Step 8: Lint and run the unit tests**

Run: `npm run lint && npm test`
Expected: lint `errors 0`; tests PASS (98).

- [ ] **Step 9: Commit**

```bash
git add extension/background/geometry.js extension/background/capture.js extension/content/indicator.js extension/manifest.json test/unit/geometry.test.js
git commit -m "Add screenshot sizing, tab capture and the page activity indicator"
```

---

### Task 14: The computer tool

**Files:**
- Create: `extension/background/tools/computer.js`, `test/unit/computer.test.js`, `test/e2e/pages/input.html`
- Modify: `extension/background/main.js`, `test/e2e/e2e.test.js` (import line + append)

**Interfaces:**
- Consumes:
  - `createCapture` (Task 13)
  - `guardFor`, `assertSameHost` (Task 9), `parseRef` (Task 7)
  - content ops `input.click|hover|scroll|scrollTo|drag|type|keys` (Tasks 11–12) and `indicator.moveCursor` (Task 13)
- Produces: `computerTool({ api, content, capture })` → `computer`
  - Redirect protocol: a content reply `{ redirect: { frameId, x?, y? } }` makes the tool re-send the same op to that frame with local coordinates and `guard: null`, after re-checking the top-level host. It follows at most 4 hops.

- [ ] **Step 1: Write the failing unit test**

`test/unit/computer.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { computerTool } from "../../extension/background/tools/computer.js";

function setup(replies = {}) {
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
  const { computer } = computerTool({ api, content, capture });
  const tab = { id: 1, url: "https://a.test/", windowId: 3, groupId: 9 };
  return { run: (args) => computer.run({ tab, args }), calls, created, grouped };
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
  await assert.rejects(run({ action: "wait", duration: 11 }), /between 0 and 10/);
  await assert.rejects(run({ action: "teleport" }), /unknown action "teleport"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/extension/background/tools/computer.js'`.

- [ ] **Step 3: Implement computer.js**

`extension/background/tools/computer.js`:
```js
import { assertSameHost, guardFor } from "../guard.js";
import { parseRef } from "../tree.js";

const CLICKS = {
  left_click: ["left", 1, "Clicked"],
  right_click: ["right", 1, "Right-clicked"],
  double_click: ["left", 2, "Double-clicked"],
  triple_click: ["left", 3, "Triple-clicked"],
};
const DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value ?? fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const image = (shot) => ({ type: "image", data: shot.base64, mimeType: shot.mimeType });

export function computerTool({ api, content, capture }) {
  async function act(tab, frameId, op, opArgs, action) {
    let frame = frameId;
    let args = { ...opArgs, guard: await guardFor(api, tab, frameId, action) };
    for (let hop = 0; ; hop++) {
      const result = (await content.call(tab.id, frame, op, args)) ?? {};
      if (!result.redirect) return result;
      if (hop >= 4) throw new Error("Too many nested frames");
      await assertSameHost(api, tab, action);
      frame = result.redirect.frameId;
      args = { ...opArgs, x: result.redirect.x ?? opArgs.x, y: result.redirect.y ?? opArgs.y, guard: null };
    }
  }

  function pointerTarget(tab, args, action) {
    if (args.ref != null && args.coordinate != null) throw new Error(`${action}: provide either ref or coordinate, not both`);
    if (args.ref != null) {
      const { frameId, ref } = parseRef(args.ref);
      return { frameId, args: { ref }, label: args.ref };
    }
    if (!Array.isArray(args.coordinate) || args.coordinate.length !== 2) throw new Error(`${action}: coordinate [x, y] or ref is required`);
    const [x, y] = args.coordinate.map(Number);
    const css = capture.toCss(tab.id, [x, y]);
    return { frameId: 0, args: { x: css.x, y: css.y }, label: `at (${x}, ${y})` };
  }

  async function moveCursor(tabId, frameId, point) {
    if (frameId === 0 && point) await content.call(tabId, 0, "indicator.moveCursor", point).catch(() => {});
  }

  async function screenshotBlocks(tab, scale) {
    const shot = await capture.screenshot(tab.id, { scale });
    const scaled = shot.width !== shot.frame.width ? `, scaled; coordinates use the ${shot.frame.width}x${shot.frame.height} frame` : "";
    return [{ type: "text", text: `Screenshot ${shot.width}x${shot.height} (jpeg)${scaled}` }, image(shot)];
  }

  async function run({ tab, args }) {
    const { action } = args;
    if (CLICKS[action]) {
      const [button, count, verb] = CLICKS[action];
      const target = pointerTarget(tab, args, action);
      const result = await act(tab, target.frameId, "input.click", { ...target.args, button, count, modifiers: args.modifiers ?? "" }, action);
      await moveCursor(tab.id, target.frameId, result.point);
      let text = `${verb} ${target.label}`;
      for (const url of result.opened ?? []) {
        const opened = await api.tabs.create({ url, openerTabId: tab.id, windowId: tab.windowId, active: false });
        await api.tabs.group({ groupId: tab.groupId, tabIds: [opened.id] });
        text += ` (link opened in new tab ${opened.id})`;
      }
      return text;
    }
    switch (action) {
      case "screenshot":
        return screenshotBlocks(tab, args.scale);
      case "zoom": {
        if (!Array.isArray(args.region) || args.region.length !== 4) throw new Error("zoom: region [x0, y0, x1, y1] is required");
        const region = args.region.map(Number);
        const shot = await capture.zoom(tab.id, region, { scale: args.scale });
        return [{ type: "text", text: `Zoomed region (${region[0]}, ${region[1]})-(${region[2]}, ${region[3]}) at ${shot.width}x${shot.height}` }, image(shot)];
      }
      case "wait": {
        const seconds = Number(args.duration);
        if (!(seconds > 0 && seconds <= 10)) throw new Error("wait: duration must be between 0 and 10 seconds");
        await sleep(seconds * 1000);
        return `Waited ${seconds} second(s)`;
      }
      case "hover": {
        const target = pointerTarget(tab, args, action);
        const result = await act(tab, target.frameId, "input.hover", target.args, action);
        await moveCursor(tab.id, target.frameId, result.point);
        return `Hovered ${target.label}`;
      }
      case "scroll": {
        const direction = DIRECTIONS[args.scroll_direction];
        if (!direction) throw new Error('scroll: scroll_direction must be "up", "down", "left" or "right"');
        const amount = clampInt(args.scroll_amount, 1, 10, 3);
        const target = pointerTarget(tab, args, action);
        await act(tab, target.frameId, "input.scroll", { ...target.args, dx: direction[0] * amount * 100, dy: direction[1] * amount * 100 }, action);
        await sleep(200);
        return [{ type: "text", text: `Scrolled ${args.scroll_direction} by ${amount} ${target.label}` }, ...(await screenshotBlocks(tab, 1))];
      }
      case "scroll_to": {
        if (args.ref == null) throw new Error("scroll_to: ref is required");
        const { frameId, ref } = parseRef(args.ref);
        await act(tab, frameId, "input.scrollTo", { ref }, action);
        return `Scrolled ${args.ref} into view`;
      }
      case "left_click_drag": {
        if (!Array.isArray(args.start_coordinate) || !Array.isArray(args.coordinate)) throw new Error("left_click_drag: start_coordinate and coordinate are required");
        const [sx, sy] = args.start_coordinate.map(Number);
        const [ex, ey] = args.coordinate.map(Number);
        const from = capture.toCss(tab.id, [sx, sy]);
        const to = capture.toCss(tab.id, [ex, ey]);
        const result = await act(tab, 0, "input.drag", { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }, action);
        await moveCursor(tab.id, 0, result.point);
        return `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})`;
      }
      case "type": {
        if (typeof args.text !== "string" || args.text === "") throw new Error("type: text is required");
        await act(tab, 0, "input.type", { text: args.text }, action);
        return `Typed ${JSON.stringify(args.text)}`;
      }
      case "key": {
        if (typeof args.text !== "string" || !args.text.trim()) throw new Error("key: text is required");
        const repeat = clampInt(args.repeat, 1, 100, 1);
        const result = await act(tab, 0, "input.keys", { spec: args.text, repeat }, action);
        if (result.reload) {
          await api.tabs.reload(tab.id, { bypassCache: result.reload.bypassCache });
          return `Reloaded the tab${result.reload.bypassCache ? " (bypassing the cache)" : ""}`;
        }
        return `Pressed ${args.text}${repeat > 1 ? ` ×${repeat}` : ""}`;
      }
      default:
        throw new Error(`computer: unknown action "${action}"`);
    }
  }

  return { computer: { tabScoped: true, run } };
}
```

The scroll test expects `"Scrolled down by 3 at (1, 1)"`. That holds because `label` for coordinates is `at (x, y)`, and the click output becomes `Clicked at (10, 20)` or `Clicked ref_4`.

- [ ] **Step 4: Run the unit tests**

Run: `npm test`
Expected: PASS (105 tests).

- [ ] **Step 5: Wire capture and the tool into main.js**

In `extension/background/main.js` add the imports:
```js
import { createCapture } from "./capture.js";
import { computerTool } from "./tools/computer.js";
```
after `const activity = createActivity({ api, content });` add:
```js
const capture = createCapture({ api, content });
```
and add `...computerTool({ api, content, capture }),` to the `tools` object.

- [ ] **Step 6: Add the input fixture**

`test/e2e/pages/input.html`:
```html
<!doctype html><title>Input lab</title>
<style>
  body { margin: 0; font: 16px sans-serif; }
  .abs { position: absolute; }
  #big { left: 40px; top: 40px; width: 200px; height: 60px; }
  #hover-target { left: 260px; top: 40px; width: 120px; height: 30px; background: #eee; }
  #drag-source { left: 400px; top: 40px; width: 100px; height: 40px; background: #cde; }
  #drop-zone { left: 400px; top: 120px; width: 200px; height: 80px; border: 2px dashed #888; }
  #scroller { left: 40px; top: 120px; width: 200px; height: 120px; overflow: auto; border: 1px solid #888; }
  #scroller div { height: 600px; }
  #flow { margin-top: 260px; padding: 0 40px; }
</style>
<button id="big" class="abs" onclick="log('clicked big')" ondblclick="log('dblclicked big')" oncontextmenu="log('context big'); return false">Big button</button>
<span id="hover-target" class="abs" onmouseover="log('hovered')">Hover me</span>
<div id="drag-source" class="abs" draggable="true" ondragstart="event.dataTransfer.setData('text/plain', 'payload')">Drag me</div>
<div id="drop-zone" class="abs" ondragover="event.preventDefault()" ondrop="event.preventDefault(); log('dropped ' + event.dataTransfer.getData('text/plain'))">Drop here</div>
<div id="scroller" class="abs"><div>Tall content</div></div>
<div id="flow">
  <form onsubmit="event.preventDefault(); log('submitted ' + new FormData(this).get('q'))">
    <label for="q">Query</label> <input id="q" name="q"> <button>Go</button>
  </form>
  <p><a id="newtab" href="/basic.html" target="_blank">Open basic in new tab</a></p>
  <div id="editor" contenteditable="true" aria-label="Editor" style="border: 1px solid #888; min-height: 2em"></div>
  <pre id="log"></pre>
</div>
<script>function log(m) { document.getElementById("log").textContent += m + "\n"; }</script>
```

- [ ] **Step 7: Add the e2e tests**

In `test/e2e/e2e.test.js` change the harness import to:
```js
import { imagesOf, startHarness, textOf } from "./harness.js";
```
Then append:
```js
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
```

- [ ] **Step 8: Run lint and e2e**

Run: `npm run lint && npm run e2e`
Expected: lint `errors 0`; e2e PASS (31 tests).

- [ ] **Step 9: Commit**

```bash
git add extension/background/tools/computer.js extension/background/main.js test/unit/computer.test.js test/e2e/pages/input.html test/e2e/e2e.test.js
git commit -m "Add the computer tool: clicks, typing, keys, scroll, drag, zoom and screenshots"
```

---

### Task 15: Console and network logs

**Files:**
- Create: `extension/content/console-hook.js`, `extension/background/logs.js`, `extension/background/tools/logs.js`, `test/unit/logs.test.js`, `test/e2e/pages/console.html`
- Modify: `extension/manifest.json`, `extension/background/main.js`, `test/e2e/e2e.test.js` (append)

**Interfaces:**
- Consumes: `runtime.onMessage` messages `{ type: "console", entries: [{ level, text, url, time }] }` sent by the console hook
- Produces:
  - `createLogStore({ maxConsole?, maxNetwork? })` → `{ addConsole, committed, requestStarted, requestFinished, removeTab, readConsole(tabId, opts) → string, readNetwork(tabId, opts) → string }`
  - `installLogListeners(api, store)`
  - `logTools({ store })` → `read_console_messages`, `read_network_requests`

- [ ] **Step 1: Write the failing tests**

`test/unit/logs.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { createLogStore } from "../../extension/background/logs.js";

const message = (level, text) => ({ level, text, url: "u", time: 0 });

test("console messages filter by level and pattern and keep the newest on overflow", () => {
  const store = createLogStore({ maxConsole: 3 });
  store.committed(1, "https://a.test/");
  store.addConsole(1, [message("log", "one"), message("error", "Boom two"), message("warn", "three"), message("log", "four")]);
  const all = store.readConsole(1);
  assert.match(all, /^Found 3 console message\(s\):/);
  assert.doesNotMatch(all, /\bone\b/);
  assert.match(store.readConsole(1, { onlyErrors: true }), /\[ERROR\] \(u\) Boom two/);
  assert.match(store.readConsole(1, { pattern: "^four$" }), /^Found 1 /);
  assert.match(store.readConsole(1, { pattern: "([" }), /No console messages found matching "\(\["/);
  assert.match(store.readConsole(1, { limit: 1 }), /showing the last 1/);
});

test("console buffers reset on a new origin and clear empties them", () => {
  const store = createLogStore();
  store.committed(1, "https://a.test/x");
  store.addConsole(1, [message("log", "first page")]);
  store.committed(1, "https://a.test/y");
  assert.match(store.readConsole(1), /first page/);
  store.committed(1, "https://b.test/");
  assert.match(store.readConsole(1), /^No console messages found\.$/);
  store.addConsole(1, [message("log", "second page")]);
  assert.match(store.readConsole(1, { clear: true }), /second page/);
  assert.match(store.readConsole(1), /^No console messages found\.$/);
});

test("network requests are listed with status and reset on a new top-level origin", () => {
  const store = createLogStore();
  store.requestStarted(1, { requestId: "1", method: "GET", url: "https://a.test/", type: "main_frame" });
  store.requestStarted(1, { requestId: "2", method: "POST", url: "https://a.test/api/save", type: "xmlhttprequest" });
  store.requestFinished(1, "1", "200");
  store.requestFinished(1, "2", "failed (NS_ERROR_NET_RESET)");
  assert.equal(store.readNetwork(1, { urlPattern: "/api/" }), "Found 1 request(s):\n\n1. url: https://a.test/api/save\n   method: POST\n   statusCode: failed (NS_ERROR_NET_RESET)");
  store.requestStarted(1, { requestId: "3", method: "GET", url: "https://b.test/", type: "main_frame" });
  assert.equal(store.readNetwork(1), "Found 1 request(s):\n\n1. url: https://b.test/\n   method: GET\n   statusCode: pending");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/extension/background/logs.js'`.

- [ ] **Step 3: Implement logs.js and the log tools**

`extension/background/logs.js`:
```js
const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

function makeMatcher(pattern) {
  if (!pattern) return () => true;
  try {
    const re = new RegExp(pattern, "i");
    return (text) => re.test(text);
  } catch {
    const needle = pattern.toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
  }
}

export function createLogStore({ maxConsole = 10_000, maxNetwork = 1_000 } = {}) {
  const tabs = new Map();
  const entry = (tabId) => {
    let state = tabs.get(tabId);
    if (!state) {
      state = { consoleOrigin: null, networkOrigin: null, console: [], network: new Map() };
      tabs.set(tabId, state);
    }
    return state;
  };

  return {
    addConsole(tabId, entries) {
      const state = entry(tabId);
      state.console.push(...entries);
      if (state.console.length > maxConsole) state.console.splice(0, state.console.length - maxConsole);
    },
    committed(tabId, url) {
      const state = entry(tabId);
      const origin = originOf(url);
      if (state.consoleOrigin !== origin) {
        state.console = [];
        state.consoleOrigin = origin;
      }
    },
    requestStarted(tabId, { requestId, method, url, type }) {
      const state = entry(tabId);
      if (type === "main_frame" && state.networkOrigin !== originOf(url)) {
        state.network.clear();
        state.networkOrigin = originOf(url);
      }
      state.network.set(requestId, { method, url, type, status: "pending" });
      if (state.network.size > maxNetwork) state.network.delete(state.network.keys().next().value);
    },
    requestFinished(tabId, requestId, status) {
      const request = tabs.get(tabId)?.network.get(requestId);
      if (request) request.status = status;
    },
    removeTab(tabId) {
      tabs.delete(tabId);
    },
    readConsole(tabId, { onlyErrors = false, pattern, limit = 100, clear = false } = {}) {
      const state = entry(tabId);
      const matches = makeMatcher(pattern);
      const found = state.console.filter((m) => (!onlyErrors || m.level === "error" || m.level === "exception") && matches(m.text));
      if (clear) state.console = [];
      if (!found.length) return `No console messages found${pattern ? ` matching "${pattern}"` : ""}${onlyErrors ? " (errors only)" : ""}.`;
      const shown = found.slice(-limit);
      const header = `Found ${found.length} console message(s)${found.length > shown.length ? `, showing the last ${shown.length}` : ""}:`;
      return [header, "", ...shown.map((m, i) => `[${i + 1}] [${clock(m.time)}] [${m.level.toUpperCase()}] (${m.url}) ${m.text}`)].join("\n");
    },
    readNetwork(tabId, { urlPattern, limit = 100, clear = false } = {}) {
      const state = entry(tabId);
      const found = [...state.network.values()].filter((r) => !urlPattern || r.url.includes(urlPattern));
      if (clear) state.network.clear();
      if (!found.length) return `No network requests found${urlPattern ? ` matching "${urlPattern}"` : ""}.`;
      const shown = found.slice(-limit);
      const header = `Found ${found.length} request(s)${found.length > shown.length ? `, showing the last ${shown.length}` : ""}:`;
      return [header, "", ...shown.map((r, i) => `${i + 1}. url: ${r.url}\n   method: ${r.method}\n   statusCode: ${r.status}`)].join("\n");
    },
  };
}

export function installLogListeners(api, store) {
  const filter = { urls: ["<all_urls>"] };
  api.webRequest.onBeforeRequest.addListener((d) => { if (d.tabId >= 0) store.requestStarted(d.tabId, d); }, filter);
  api.webRequest.onCompleted.addListener((d) => { if (d.tabId >= 0) store.requestFinished(d.tabId, d.requestId, String(d.statusCode)); }, filter);
  api.webRequest.onErrorOccurred.addListener((d) => { if (d.tabId >= 0) store.requestFinished(d.tabId, d.requestId, `failed (${d.error})`); }, filter);
  api.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) store.committed(d.tabId, d.url); });
  api.tabs.onRemoved.addListener((tabId) => store.removeTab(tabId));
  api.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === "console" && sender.tab) store.addConsole(sender.tab.id, msg.entries);
  });
}
```

`extension/background/tools/logs.js`:
```js
export function logTools({ store }) {
  return {
    read_console_messages: {
      tabScoped: true,
      run: async ({ tab, args }) => store.readConsole(tab.id, { onlyErrors: args.onlyErrors === true, pattern: args.pattern, limit: args.limit ?? 100, clear: args.clear === true }),
    },
    read_network_requests: {
      tabScoped: true,
      run: async ({ tab, args }) => store.readNetwork(tab.id, { urlPattern: args.urlPattern, limit: args.limit ?? 100, clear: args.clear === true }),
    },
  };
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npm test`
Expected: PASS (108 tests).

- [ ] **Step 5: Implement the console hook**

`extension/content/console-hook.js`:
```js
(() => {
  if (globalThis.__cf?.consoleHook) return;
  const cf = (globalThis.__cf ??= {});
  cf.consoleHook = true;
  const page = window.wrappedJSObject;
  const queue = [];
  let timer = null;

  const flush = () => {
    timer = null;
    const entries = queue.splice(0);
    if (entries.length) browser.runtime.sendMessage({ type: "console", entries }).catch(() => {});
  };

  const record = (level, text) => {
    queue.push({ level, text: text.length > 16_384 ? `${text.slice(0, 16_384)}…[truncated]` : text, url: location.href, time: Date.now() });
    timer ??= setTimeout(flush, 250);
  };

  const format = (value) => {
    try {
      if (typeof value === "string") return value;
      if (value === undefined) return "undefined";
      if (typeof value !== "object" || value === null) return String(value);
      const raw = XPCNativeWrapper.unwrap(value);
      if (typeof raw.message === "string" && typeof raw.name === "string" && "stack" in raw) return `${raw.name}: ${raw.message}`;
      return JSON.stringify(raw) ?? String(raw);
    } catch {
      try {
        return String(value);
      } catch {
        return "[unprintable]";
      }
    }
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = page.console[level];
    exportFunction(function consoleProxy(...args) {
      record(level, args.map(format).join(" "));
      return original.apply(this, args);
    }, page.console, { defineAs: level });
  }
  window.addEventListener("error", (event) => record("exception", `${event.message} (${event.filename}:${event.lineno}:${event.colno})`));
  window.addEventListener("unhandledrejection", (event) => record("exception", `Unhandled promise rejection: ${format(event.reason)}`));
})();
```

In `extension/manifest.json`, make `content/console-hook.js` the first file of the `all_frames` entry:
```json
      "js": ["content/console-hook.js", "content/dom.js", "content/tree.js", "content/form.js", "content/text.js", "content/input.js", "content/router.js"]
```

- [ ] **Step 6: Wire the store into main.js**

In `extension/background/main.js` add the imports:
```js
import { createLogStore, installLogListeners } from "./logs.js";
import { logTools } from "./tools/logs.js";
```
after `const capture = createCapture({ api, content });` add:
```js
const store = createLogStore();
installLogListeners(api, store);
```
and add `...logTools({ store }),` to the `tools` object.

- [ ] **Step 7: Add the console fixture and e2e tests**

`test/e2e/pages/console.html`:
```html
<!doctype html><title>Console</title>
<button onclick="console.warn('button warn', { n: 1 }); fetch('/api/ping')">Log and fetch</button>
<script>
  console.log("page loaded", 42);
  console.error(new Error("boom on load"));
  setTimeout(() => { throw new Error("async explosion"); }, 0);
</script>
```

Append to `test/e2e/e2e.test.js`:
```js
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
```

- [ ] **Step 8: Run lint and e2e**

Run: `npm run lint && npm run e2e`
Expected: lint `errors 0`; e2e PASS (34 tests).

- [ ] **Step 9: Commit**

```bash
git add extension/content/console-hook.js extension/background/logs.js extension/background/tools/logs.js extension/background/main.js extension/manifest.json test/unit/logs.test.js test/e2e/pages/console.html test/e2e/e2e.test.js
git commit -m "Add console and network capture with read tools"
```

---

### Task 16: file_upload and browser_batch end to end

**Files:**
- Modify: `extension/content/form.js`, `extension/background/tools/page.js`, `test/unit/form.test.js`, `test/e2e/e2e.test.js` (append)
- Create: `test/e2e/pages/upload.html`, `test/e2e/pages/upload-sample.txt`

**Interfaces:**
- Consumes: `file_upload` args from the MCP server (Task 3): `{ ref, tabId, files: [{ name, mimeType, base64 }] }`; `guardFor` (Task 9)
- Produces:
  - Content `__cf.form.setFiles({ ref, files, guard }) → "Uploaded N file(s) to <ref>: a, b"`
  - The `file_upload` entry in `pageTools`

- [ ] **Step 1: Write the failing unit test**

Append to `test/unit/form.test.js`:
```js
test("setFiles refuses elements that are not file inputs", () => {
  const w = loadContent(`<label for="n">Name</label><input id="n">`, FILES);
  assert.throws(() => w.__cf.form.setFiles({ ref: refByName(w, "Name"), files: [], guard: null }), /is not an <input type="file">/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, `w.__cf.form.setFiles is not a function`.

- [ ] **Step 3: Implement setFiles**

In `extension/content/form.js`, replace
```js
  cf.form = { setValue };
```
with:
```js
  function setFiles({ ref, files, guard }) {
    const el = cf.tree.resolve(ref);
    if (el.tagName.toUpperCase() !== "INPUT" || el.type !== "file") throw new Error(`${ref} is not an <input type="file">`);
    cf.dom.guardHost(guard);
    const win = el.ownerDocument.defaultView;
    const transfer = new win.DataTransfer();
    for (const file of files) {
      const binary = atob(file.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      transfer.items.add(new win.File([bytes], file.name, { type: file.mimeType }));
    }
    el.files = transfer.files;
    fire(el, "input");
    fire(el, "change");
    return `Uploaded ${files.length} file(s) to ${ref}: ${files.map((f) => f.name).join(", ")}`;
  }

  cf.form = { setValue, setFiles };
```

- [ ] **Step 4: Add the tool entry**

In `extension/background/tools/page.js` add after the `form_input` entry:
```js
    file_upload: {
      tabScoped: true,
      async run({ tab, args }) {
        if (!Array.isArray(args.files) || args.files.length === 0) throw new Error("file_upload: no files were provided");
        const { frameId, ref } = parseRef(args.ref);
        const guard = await guardFor(api, tab, frameId, "file_upload");
        return content.call(tab.id, frameId, "form.setFiles", { ref, files: args.files, guard });
      },
    },
```

- [ ] **Step 5: Run the unit tests**

Run: `npm test`
Expected: PASS (109 tests).

- [ ] **Step 6: Add fixtures and e2e tests**

`test/e2e/pages/upload.html`:
```html
<!doctype html><title>Upload</title>
<label for="file">Attachment</label><input id="file" type="file" multiple>
<pre id="log"></pre>
<script>
  document.getElementById("file").addEventListener("change", (e) => {
    for (const f of e.target.files) document.getElementById("log").textContent += `${f.name} ${f.size} ${f.type}\n`;
  });
</script>
```

`test/e2e/pages/upload-sample.txt` (exactly 13 bytes, including the trailing newline):
```text
hello upload
```

At the top of `test/e2e/e2e.test.js` add:
```js
import { fileURLToPath } from "node:url";
```
Then append:
```js
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
```

- [ ] **Step 7: Run lint and e2e**

Run: `npm run lint && npm run e2e`
Expected: lint `errors 0`; e2e PASS (36 tests).

- [ ] **Step 8: Commit**

```bash
git add extension/content/form.js extension/background/tools/page.js test/unit/form.test.js test/e2e/pages/upload.html test/e2e/pages/upload-sample.txt test/e2e/e2e.test.js
git commit -m "Add file_upload and cover browser_batch end to end"
```

---

### Task 17: README, build and hand-off

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything
- Produces: `web-ext-artifacts/claude_in_firefox-0.1.0.zip`, which is gitignored

- [ ] **Step 1: Write README.md**

`README.md`:
````markdown
# Claude in Firefox

Drive your everyday Firefox from Claude Code. A Firefox extension plus a local MCP bridge gives Claude browser tools modeled on Claude in Chrome: navigate, click, type, take screenshots, read the page, fill forms, run JavaScript, and read console and network logs. It works in your real profile, with your logins, and it refuses no domain.

## How it works

```
Claude Code ──MCP stdio──▶ host/src/mcp-server.js ──unix socket──▶ host/src/native-host.js ──native messaging──▶ extension
```

Each Claude Code session gets its own Firefox tab group (`Claude · xxxx`) and can only touch tabs inside it. An orange glow and a phantom cursor show which tab Claude is working in.

## Requirements

- macOS, Node ≥ 20, Claude Code
- Firefox Developer Edition 139 or newer: `brew install --cask firefox@developer-edition`

## Install

1. `npm install`
2. `npm run install-host`. This writes the native-messaging manifest to `~/Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json` and prints a `claude mcp add` command.
3. Run the printed `claude mcp add --scope user firefox -- …` command.
4. In Firefox Developer Edition, open `about:config` and set `xpinstall.signatures.required` to `false`.
5. `npm run build`, then in Firefox open `about:addons` → gear menu → *Install Add-on From File…* and pick `web-ext-artifacts/claude_in_firefox-0.1.0.zip`.
6. Start a new Claude Code session and ask it to use the `firefox` tools. It should begin with `tabs_context` and `createIfEmpty: true`.

After pulling changes, run `npm run build` and reinstall the add-on. Re-run `npm run install-host` only if you moved the repository or changed Node installations.

## Tools

| Tool | What it does |
|---|---|
| `tabs_context`, `tabs_create`, `tabs_close` | List, open and close tabs in this session's group |
| `navigate` | Load a URL (or go back/forward) and wait up to 15 s for it to finish |
| `computer` | Clicks, typing, keys, scroll, hover, drag, screenshots, zoom, wait |
| `read_page`, `find` | Accessibility-tree outline with stable `ref_N` ids; keyword search over it |
| `form_input`, `file_upload` | Set form controls by ref; put local files into file inputs |
| `get_page_text` | Readable text of the main content |
| `javascript_tool` | Evaluate JavaScript in the page |
| `read_console_messages`, `read_network_requests` | Console output and HTTP requests since the page's origin loaded |
| `resize_window` | Resize the browser window |
| `browser_batch` | Run several of the above in one round trip |

## Safety

- **No domain blocking.** Claude in Chrome checks every URL against Anthropic's site-category service and enterprise blocklists. This extension does neither, and it shows no per-site permission prompts. Claude Code's own permission settings are the only gate.
- **Firefox's own restrictions still apply.** Firefox keeps every extension off its privileged pages (`about:*`, other extensions' pages) and off the domains listed in the `extensions.webextensions.restrictedDomains` pref, such as addons.mozilla.org. To allow those domains, clear that pref and set `privacy.resistFingerprinting.block_mozAddonManager` to `true` in `about:config`. The installer never changes Firefox prefs.
- **Two guards are kept:**
  - Password, one-time-code and payment-card field values show as `[value redacted]` in `read_page` and `form_input` output.
  - Input is aborted if the tab switched to another domain mid-action.
- **Prompt injection is a real risk.** Web pages can contain text written to steer Claude. Claude acts with your logged-in sessions, so review what you ask it to do on sensitive sites, especially if you run Claude Code without permission prompts.

## Limitations

- Firefox gives extensions no OS-level input, so clicks and keys are synthesized inside the page (`isTrusted: false`). As a result:
  - CSS `:hover` does not apply.
  - Native `<select>` popups and file pickers cannot be operated (use `form_input` / `file_upload`).
  - Clipboard paste is unavailable.
  - Pages that ignore script-generated events will not react.
- Only one Firefox profile can run the extension at a time; a second profile's native host exits.
- Reloading the extension forgets the session-to-group mapping. Call `tabs_context` with `createIfEmpty: true` again.
- Capturing a tab in a minimized window: see Appendix A of the design spec for the observed behavior.

## Development

```bash
npm test          # unit tests (node:test + jsdom)
npm run lint      # web-ext lint
npm run e2e       # drives a real Firefox Developer Edition; needs `npm run install-host` and no other instance running the extension
npm run build     # packages the extension into web-ext-artifacts/
```

E2E uses `FIREFOX_BIN` if set, otherwise `/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox`.

Design: `docs/superpowers/specs/2026-10-17-claude-in-firefox-design.md`. Notes on how Claude in Chrome works: `docs/reference/claude-in-chrome-internals.md`.

## Troubleshooting

- **"Firefox extension not connected".** Firefox Developer Edition isn't running, the add-on isn't installed, or `npm run install-host` wasn't run. The Browser Console (⌘⇧J) shows native host errors prefixed `claude-firefox native host:`.
- **"Cannot access this page".** The page is one Firefox reserves (see Safety).
- **Clicks land in the wrong place.** Take a fresh `screenshot` first: coordinates always refer to the most recent screenshot of that tab.
````

- [ ] **Step 2: Run the full verification**

```bash
npm test
npm run lint
npm run e2e
npm run build
```
Expected: unit PASS (109); lint `errors 0`; e2e PASS (36); `web-ext-artifacts/claude_in_firefox-0.1.0.zip` created.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Add README with install, safety and limitations"
```

- [ ] **Step 4: Hand off to the user**

Report the verification output. Then ask the user before each of the following, since each touches state outside the repo:
1. Running the `claude mcp add --scope user firefox -- …` command that `npm run install-host` printed.
2. Installing `web-ext-artifacts/claude_in_firefox-0.1.0.zip` into their Firefox Developer Edition. The user does this in `about:addons`; the plan does not automate it.
