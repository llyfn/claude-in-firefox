# Claude Code Bridge for Firefox

> An independent project. Not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.

Drive your everyday Firefox from Claude Code. A Firefox extension plus a local MCP bridge gives Claude browser tools modeled on Claude in Chrome: navigate, click, type, take screenshots, read the page, fill forms, and read console and network logs. It works in your real profile, with your logins, and it refuses no domain.

## How it works

```
Claude Code ──MCP stdio──▶ host/src/mcp-server.js ──unix socket──▶ native-host.js ──native messaging──▶ extension
```

Each Claude Code session gets its own Firefox window, opened behind the Firefox window you are using, and can only touch tabs in that window (plus popups opened from it). The window title and, when tab groups are enabled, a tab group show the session's status: ⌛ working, ✅ idle, ⏸ stopped. A violet glow and a phantom cursor show which tab Claude is working in.

The MCP server runs from this repository. The native host is the process Firefox launches, and it runs from a copy outside the repository (`~/Library/Application Support/claude-in-firefox/host/` on macOS, `~/.local/share/claude-in-firefox/host/` on Linux), because macOS privacy protection blocks processes that Firefox launches from reading `~/Desktop`, `~/Documents` and `~/Downloads`.

## Requirements

- macOS or Linux, Node ≥ 20 to run, Claude Code. On Linux, use a Firefox installed from Mozilla or your distribution's package; the Snap and Flatpak builds keep native-messaging hosts elsewhere and are not supported.
- Firefox 140 or newer. The signed add-on works in regular Firefox; unsigned development builds need Firefox Developer Edition or Nightly.
- Node ≥ 22.22 for development and tests (jsdom 30 requires it).

## Install

1. Download the `.xpi` from the [latest release](https://github.com/llyfn/claude-in-firefox/releases/latest) and open it in Firefox to install the signed add-on.
2. Clone this repository, then run `npm install` and `npm run install-host`. The installer copies the native host's runtime files (`native-host.js`, `framing.js`, `paths.js`, and a `package.json` with `"type": "module"`) into the host directory above, writes a `native-host` shell wrapper next to them, writes the native-messaging manifest `claude_firefox_bridge.json` (to `~/Library/Application Support/Mozilla/NativeMessagingHosts/` on macOS, `~/.mozilla/native-messaging-hosts/` on Linux) pointing at that wrapper, and prints a `claude mcp add` command.
3. Run the printed `claude mcp add --scope user firefox -- …` command.
4. Start a new Claude Code session and ask it to use the `firefox` tools. It should begin with `tabs_context` and `createIfEmpty: true`.

To update, install the `.xpi` from the newer release (the add-on does not update itself), `git pull`, and re-run `npm run install-host`, because Firefox runs a copy of the host. The MCP server always runs from the repository.

## Tools

| Tool | What it does |
|---|---|
| `tabs_context`, `tabs_create`, `tabs_close` | List, open and close tabs in this session's window |
| `navigate` | Load a URL (or go back/forward) and wait up to 15 s for it to finish |
| `computer` | Clicks, typing, keys, scroll, hover, drag, screenshots, zoom, wait (up to 30 s); clicks, typing and keys wait for any navigation they start |
| `read_page`, `find` | Accessibility-tree outline with stable `ref_N` ids; keyword search over it |
| `form_input`, `file_upload` | Set form controls by ref; put local files into file inputs |
| `get_page_text` | Readable text of the main content |
| `read_console_messages`, `read_network_requests` | Console output and HTTP requests since the page's origin loaded |
| `resize_window` | Resize the browser window |
| `browser_batch` | Run several of the above in one round trip |

## Safety

- **Stop button.** Every page in a session window shows a "Claude is using this window · Stop" bar. Stop cancels the running call and makes every later call fail until you press Resume. Only a real click works; Claude's synthetic input cannot press it.
- **Dialogs are answered automatically in session tabs.** alert() is dismissed, confirm() answers OK, prompt() returns its default text, and "Leave page?" prompts are suppressed; Claude sees each dialog and the answer. While a session is stopped, dialogs appear normally.
- **No domain blocking.** Unlike Claude in Chrome, this extension blocks no sites and shows no per-site permission prompts. Claude Code's own permission settings are the only gate.
- **Firefox's own restrictions still apply.** Firefox keeps every extension off its privileged pages (`about:*`, other extensions' pages) and off the domains listed in the `extensions.webextensions.restrictedDomains` pref, such as addons.mozilla.org. To allow those domains, clear that pref and set `privacy.resistFingerprinting.block_mozAddonManager` to `true` in `about:config`. The installer never changes Firefox prefs.
- **Two guards are kept:**
  - Password, one-time-code and payment-card field values show as `(sensitive value hidden)` in `read_page` and as `(hidden)` in `form_input` output. Nothing else is redacted: screenshots and zoom, and console and network logs can all show sensitive values.
  - Input is aborted if the tab switched to another domain mid-action.
- **Prompt injection is a real risk.** Web pages can contain text written to steer Claude. Claude acts with your logged-in sessions, so review what you ask it to do on sensitive sites, especially if you run Claude Code without permission prompts.

## Limitations

- Firefox gives extensions no OS-level input, so clicks and keys are synthesized inside the page (`isTrusted: false`). As a result:
  - CSS `:hover` does not apply.
  - Native `<select>` popups and file pickers cannot be operated (use `form_input` / `file_upload`).
  - Clipboard paste is unavailable.
  - Pages that ignore script-generated events will not react.
- Only one Firefox profile can run the extension at a time; a second profile's native host exits.
- Disabling, reloading or updating the add-on can break `console` and page dialogs in tabs that were already open; reload those tabs.
- A dialog raised by a page's very first scripts, before the add-on has marked the tab as a session tab, appears normally and stalls that call until it times out.
- Firefox opens every new window in front. When you are using Firefox, the add-on gives focus back to your window; when another app is in front, opening a session's window brings Firefox to the front.
- Updating to 0.2.0 asks for the new "sessions" permission, which stores each session's id on its window so sessions survive add-on reloads, and Firefox restarts that reopen your previous windows.

## Development

```bash
npm test          # unit tests (node:test + jsdom)
npm run lint      # web-ext lint
npm run e2e       # drives a real Firefox Developer Edition
npm run build     # packages the extension into web-ext-artifacts/
```

To run an unsigned build, open `about:config` in Firefox Developer Edition, set `xpinstall.signatures.required` to `false`, run `npm run build`, then open `about:addons` → gear menu → *Install Add-on From File…* and pick `web-ext-artifacts/claude_code_bridge_for_firefox-<version>.zip`. Re-run `npm run install-host` after changes under `host/src`.

Development and tests need Node ≥ 22.22. E2E needs Firefox Developer Edition and a prior `npm run install-host`. Do not run it while another Firefox instance has the add-on installed: only one native host can own the bridge socket.

E2E uses `FIREFOX_BIN` if set, otherwise `/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox`; on Linux set `FIREFOX_BIN` to your Firefox Developer Edition binary.

Design: `docs/superpowers/specs/2026-10-17-claude-in-firefox-design.md`.

## Releasing

Releases are signed by addons.mozilla.org as an unlisted add-on (not shown in the add-ons store) and attached to a GitHub release by `.github/workflows/release.yml`.

One-time setup:

1. Create an addons.mozilla.org account and generate API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
2. Store them as repository secrets: `gh secret set AMO_JWT_ISSUER` and `gh secret set AMO_JWT_SECRET`.

For each release:

1. Bump `version` in `extension/manifest.json` (and `package.json`). addons.mozilla.org refuses to sign a version it has already signed.
2. Commit, then push a matching tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The workflow checks that the tag matches the manifest version, runs the unit tests and lint, signs the add-on, and publishes the release with the signed `.xpi`.

## Troubleshooting

- **"Firefox extension not connected".** Firefox isn't running, the add-on isn't installed, or `npm run install-host` wasn't run. The Browser Console (⌘⇧J) shows native host errors prefixed `claude-firefox native host:`.
- **Native host or MCP server stops starting after a Node upgrade.** The installer records the first `node` on `PATH`. After changing Node installations, re-run `npm run install-host` and update the `claude mcp add` entry with the command it prints.
- **"Cannot access this page".** The page is one Firefox reserves (see Safety).
- **Clicks land in the wrong place.** Take a fresh `screenshot` first: coordinates always refer to the most recent screenshot of that tab.
