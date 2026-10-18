# Claude Code Bridge for Firefox

Let Claude Code drive your everyday Firefox: open tabs, click, type, read pages, fill forms, take screenshots, and read console and network logs.

It works in your real profile, with your logins. Read [Safety](#safety) before you use it on sites that matter.

> An independent project, not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.

## Quick start

You need Firefox 140 or newer and Node 20 or newer, on macOS, Linux or Windows. On Linux, the Snap and Flatpak builds of Firefox are not supported.

1. **Add-on.** Download the `.xpi` from the [latest release](https://github.com/llyfn/claude-in-firefox/releases/latest) and open it in Firefox.
2. **Bridge.** Run:
   ```bash
   npx @llyfn/claude-in-firefox install
   ```
   This registers the bridge with Firefox and adds a `firefox` MCP server to Claude Code. Add `--no-claude` to skip the Claude Code step. Run it from your home folder, not inside a project: npx puts that project's `node_modules/.bin` first on PATH, where a package could stand in for `node`.
3. **Use it.** Start a new Claude Code session and ask it to use Firefox.

## How it works

```
Claude Code ──▶ claude-firefox mcp ──socket or pipe──▶ native host ──native messaging──▶ add-on
```

- Each Claude Code session gets its own Firefox window, opened behind yours. It can only touch tabs in that window, plus popups opened from them.
- The window title, and the tab group when tab groups are on, show the session's status: ⌛ working, ✅ idle, ⏸ stopped.
- A violet glow and a cursor show which tab Claude is working in.
- On Windows the two halves of the bridge talk over a named pipe. Before using the pipe, the MCP server checks that the process at the other end holds a key that only your user account can read.

## Tools

| Tool | What it does |
|---|---|
| `tabs_context`, `tabs_create`, `tabs_close` | List, open and close the session's tabs |
| `navigate` | Load a URL, or go back or forward, waiting up to 15 s for the page to load |
| `computer` | Click, type, press keys, scroll, hover, drag, take screenshots, zoom, wait |
| `read_page`, `find` | Accessibility-tree outline with `ref_N` ids, and keyword search over it |
| `form_input`, `file_upload` | Set form fields by ref, and attach local files to file inputs |
| `get_page_text` | Readable text of the page's main content |
| `read_console_messages`, `read_network_requests` | Console output and HTTP requests since the page's origin loaded |
| `resize_window` | Resize the session window |
| `browser_batch` | Run several of these tools in one call |

## Safety

- **It acts as you.** Claude uses your logged-in sessions. The add-on blocks no sites and asks no per-site permission; Claude Code's own permission settings are the only gate.
- **Prompt injection is a real risk.** A page can contain text written to steer Claude. Be careful on sensitive sites, especially if you run Claude Code without permission prompts.
- **Stop button.** Every page in a session window shows a "Claude is using this window · Stop" bar. Stop cancels the running call and blocks all later calls until you press Resume. Only a real click works; Claude's synthetic input can't press it.
  - Some pages can't show the bar: `about:` pages (including a new window's blank tab), other add-ons' pages, PDFs and restricted sites. On those, close the window to end the session.
- **Dialogs are answered automatically** in session tabs, and Claude sees each answer: `alert()` is dismissed, `confirm()` gets OK, `prompt()` gets its default text, and "Leave page?" prompts are skipped. While a session is stopped, dialogs appear normally.
- **What's redacted.** Password, one-time-code and payment-card fields show as hidden in `read_page` and `form_input`. Nothing else is redacted: screenshots and console and network logs can show sensitive data.
- **Domain guard.** Input stops if the tab moves to another domain in the middle of an action.
- **Firefox's own limits still apply.** No add-on can touch `about:` pages, other add-ons' pages, or the domains in the `extensions.webextensions.restrictedDomains` pref, such as addons.mozilla.org. To allow those domains, clear that pref and set `privacy.resistFingerprinting.block_mozAddonManager` to `true` in `about:config`. The installer never changes Firefox prefs.

## Limitations

- **Synthetic input.** Firefox gives add-ons no OS-level input, so clicks and keys are simulated inside the page (`isTrusted: false`). Because of that:
  - CSS `:hover` doesn't apply.
  - Native `<select>` menus and file pickers can't be used; use `form_input` and `file_upload` instead.
  - Clipboard paste doesn't work.
  - Some pages ignore simulated events.
- **One Firefox profile at a time** can run the add-on.
- **Reload open tabs after you disable, reload or update the add-on.** Otherwise console capture and dialog handling can break in tabs that were already open.
- **Very early dialogs.** A dialog raised by a page's first scripts can show normally and stall the call until it times out.
- **Focus.** Opening a session window brings Firefox to the front if another app is active.
- **Windows** is tested in CI with Firefox Developer Edition only.

## Update and uninstall

- **Update:** run `npx @llyfn/claude-in-firefox@latest install`, then install the `.xpi` from the new release. The add-on doesn't update itself.
- **Uninstall:** run `npx @llyfn/claude-in-firefox uninstall`, then remove the add-on in `about:addons`. This removes the Claude Code entry, the Firefox registration and the bridge's files. `--no-claude` keeps the Claude Code entry.

With `--no-claude`, or when `claude` isn't on your PATH, the installer prints the `claude mcp add` command for you to run. If a `firefox` entry already exists, remove it first with `claude mcp remove --scope user firefox`.

## Other MCP clients

The installer also prints a JSON block like this. Add it to your client's MCP configuration; for Claude Desktop, that is `claude_desktop_config.json`.

```json
{ "mcpServers": { "firefox": { "command": "<path to node>", "args": ["<app directory>/node_modules/@llyfn/claude-in-firefox/host/src/cli.js", "mcp"] } } }
```

Each client process is its own session, with its own window.

## Troubleshooting

- **"Firefox extension not connected".** Check that Firefox is running, the add-on is installed, and you ran the install command. If you reinstalled after an uninstall, restart Firefox. Native host errors appear in the Browser Console (⌘⇧J on macOS, Ctrl+Shift+J elsewhere), prefixed `claude-firefox native host:`.
- **On Windows, "could not prove that it holds the key in pipe-key".** Restart Firefox: the bridge may still be running from before your last install. If that doesn't help, run the install command again, which recreates `pipe-name` and `pipe-key` in the app directory if they are missing or damaged. If the error persists, another program may be using the bridge's pipe name.
- **It stopped working after a Node upgrade.** The installer remembers the first `node` on your PATH. Run the install command again.
- **"Cannot access this page".** Firefox reserves that page for itself (see [Safety](#safety)).
- **Clicks land in the wrong place.** Take a new screenshot first. Coordinates always refer to the tab's latest screenshot.

The bridge lives in an app directory: `~/Library/Application Support/claude-in-firefox` on macOS, `~/.local/share/claude-in-firefox` on Linux, and `%LOCALAPPDATA%\claude-in-firefox` on Windows.

## Development

Development needs Node 22.22 or newer.

```bash
npm install
npm test                               # unit tests
npm run lint                           # web-ext lint
npm run install-host -- --no-claude    # install this clone like a release
npm run e2e                            # drive a real Firefox Developer Edition
npm run build                          # package the add-on into web-ext-artifacts/
```

- **e2e** needs Firefox Developer Edition and a prior `npm run install-host -- --no-claude`. On Linux, set `FIREFOX_BIN` to its path. Don't run e2e while another Firefox has the add-on installed, because only one native host can run at a time.
- **Unsigned builds** need Developer Edition or Nightly with `xpinstall.signatures.required` set to `false`. Install the `.zip` from `web-ext-artifacts/` through `about:addons` → gear menu → *Install Add-on From File…*.
- After you change anything under `host/src`, run `npm run install-host` again.
- **Design notes** are in [`docs/superpowers/specs/`](docs/superpowers/specs/).

<details>
<summary>Releasing (maintainers)</summary>

`.github/workflows/release.yml` signs the add-on with addons.mozilla.org as an unlisted add-on, publishes `@llyfn/claude-in-firefox` to npm, and attaches the signed `.xpi` to a GitHub release.

One-time setup: store three secrets in the repository's `release` environment, for example with `gh secret set NPM_TOKEN --env release`:
- `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, the API credentials from <https://addons.mozilla.org/developers/addon/api/key/>;
- `NPM_TOKEN`, an npm automation token for the `@llyfn` scope.

Only `v*` tags on `main` can use that environment, and each run waits for a maintainer's approval.

For each release:

1. Bump `version` in both `extension/manifest.json` and `package.json`. addons.mozilla.org won't sign a version twice.
2. Commit, then push a matching tag, for example `git tag v0.3.0 && git push origin v0.3.0`.
3. Approve the run in the Actions tab. The workflow then checks that the versions match the tag, runs the tests and lint, checks the npm token, signs the add-on, publishes to npm with provenance, and creates the release.

</details>

## License

[MIT](LICENSE)
