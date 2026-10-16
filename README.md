# Claude in Firefox

Drive your everyday Firefox from Claude Code. A Firefox extension plus a local MCP bridge gives Claude browser tools modeled on Claude in Chrome: navigate, click, type, take screenshots, read the page, fill forms, run JavaScript, and read console and network logs. It works in your real profile, with your logins, and it refuses no domain.

## How it works

```
Claude Code ──MCP stdio──▶ host/src/mcp-server.js ──unix socket──▶ native-host.js ──native messaging──▶ extension
```

Each Claude Code session gets its own Firefox tab group (`Claude · xxxx`) and can only touch tabs inside it. An orange glow and a phantom cursor show which tab Claude is working in.

The MCP server runs from this repository. The native host is the process Firefox launches, and it runs from a copy under `~/Library/Application Support/claude-in-firefox/host/`, because macOS privacy protection blocks processes that Firefox launches from reading `~/Desktop`, `~/Documents` and `~/Downloads`.

## Requirements

- macOS, Node ≥ 20 to run, Claude Code
- Node ≥ 22.22 for development and tests (jsdom 30 requires it)
- Firefox Developer Edition 139 or newer: `brew install --cask firefox@developer-edition`

## Install

1. `npm install`
2. `npm run install-host`. This copies the native host's runtime files (`native-host.js`, `framing.js`, `paths.js`, and a `package.json` with `"type": "module"`) into `~/Library/Application Support/claude-in-firefox/host/`, writes the native-messaging manifest to `~/Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json` pointing at the wrapper there, and prints a `claude mcp add` command.
3. Run the printed `claude mcp add --scope user firefox -- …` command.
4. In Firefox Developer Edition, open `about:config` and set `xpinstall.signatures.required` to `false`.
5. `npm run build`, then in Firefox open `about:addons` → gear menu → *Install Add-on From File…* and pick `web-ext-artifacts/claude_in_firefox-0.1.0.zip`.
6. Start a new Claude Code session and ask it to use the `firefox` tools. It should begin with `tabs_context` and `createIfEmpty: true`.

After extension changes, run `npm run build` and reinstall the add-on. After changes under `host/src`, re-run `npm run install-host`, because Firefox runs a copy of the host. The MCP server always runs from the repository.

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
- Disabling, reloading or updating the add-on can break `console` in tabs that were already open; reload those tabs.
- Reloading the extension forgets the session-to-group mapping. Call `tabs_context` with `createIfEmpty: true` again.

## Development

```bash
npm test          # unit tests (node:test + jsdom)
npm run lint      # web-ext lint
npm run e2e       # drives a real Firefox Developer Edition
npm run build     # packages the extension into web-ext-artifacts/
```

Development and tests need Node ≥ 22.22. E2E needs Firefox Developer Edition and a prior `npm run install-host`. Do not run it while another Firefox Developer Edition instance has the extension installed: only one native host can own the bridge socket.

E2E uses `FIREFOX_BIN` if set, otherwise `/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox`.

Design: `docs/superpowers/specs/2026-10-17-claude-in-firefox-design.md`. Notes on how Claude in Chrome works: `docs/reference/claude-in-chrome-internals.md`.

## Troubleshooting

- **"Firefox extension not connected".** Firefox Developer Edition isn't running, the add-on isn't installed, or `npm run install-host` wasn't run. The Browser Console (⌘⇧J) shows native host errors prefixed `claude-firefox native host:`.
- **Native host or MCP server stops starting after a Node upgrade.** The installer records the first `node` on `PATH`. After changing Node installations, re-run `npm run install-host` and update the `claude mcp add` entry with the command it prints.
- **"Cannot access this page".** The page is one Firefox reserves (see Safety).
- **Clicks land in the wrong place.** Take a fresh `screenshot` first: coordinates always refer to the most recent screenshot of that tab.
