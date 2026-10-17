# Distribution and platforms — design

Part 2 of the improvements found by comparing this project with similar Firefox add-ons. Part 1 (session windows, Stop/Resume, dialogs) shipped as 0.2.0. This part makes the bridge installable without cloning the repository, adds Windows, and documents other MCP clients. Version becomes 0.3.0.

## Goals

1. Install with one command: `npx @llyfn/claude-in-firefox install`.
2. Firefox and every MCP client run one pinned, self-contained copy of the bridge, so the two halves never run different versions and nothing goes through `npx` at startup.
3. Install registers the MCP server with Claude Code when the `claude` CLI is present; uninstall removes everything install created.
4. Windows support.
5. Setup instructions for Claude Desktop and other MCP clients.
6. CI: unit tests on Linux, macOS and Windows; e2e on Linux and Windows. Releases publish the npm package.

## Non-goals

macOS e2e in CI, npm provenance while the repository is private, Snap/Flatpak Firefox on Linux, automatic add-on updates, bundling the host into one file.

## 1. Package

- `package.json`: `"name": "@llyfn/claude-in-firefox"`, no `private`, `"publishConfig": { "access": "public" }`, `"bin": { "claude-firefox": "host/src/cli.js" }`, `"files": ["host/src", "README.md", "LICENSE"]`, `"engines": { "node": ">=20" }`. Runtime dependency stays `@modelcontextprotocol/sdk` only.
- The extension is not in the package; it keeps shipping as the signed `.xpi` on GitHub releases.

## 2. CLI

`host/src/cli.js` (with a `#!/usr/bin/env node` line):

- `claude-firefox install [--no-claude]`
- `claude-firefox uninstall [--no-claude]`
- `claude-firefox mcp` — runs the MCP server on stdio (what `node host/src/mcp-server.js` does today).
- `claude-firefox --version`, `claude-firefox --help`; anything else prints the usage and exits with status 1.

`npm run install-host` becomes `node host/src/cli.js install`.

## 3. Install

App directory (`appDir`):

| OS | appDir |
|---|---|
| macOS | `~/Library/Application Support/claude-in-firefox` |
| Linux | `~/.local/share/claude-in-firefox` |
| Windows | `%LOCALAPPDATA%\claude-in-firefox` (fallback `<home>\AppData\Local\claude-in-firefox`) |

The package lives at `<appDir>/node_modules/@llyfn/claude-in-firefox` (`pkgDir`). Steps:

1. **Source.** When `cli.js` runs from an installed package (its package root is inside a `node_modules` directory), the source is `@llyfn/claude-in-firefox@<its own version>`. When it runs from a repository clone, the source is a tarball made with `npm pack --pack-destination <temp dir>` of the clone, so development installs the same layout as users get.
2. **Copy.** `npm install --prefix <appDir> --omit=dev --no-audit --no-fund <source>`. npm is run as `node <npm_execpath>` when `process.env.npm_execpath` is set (always the case under `npx` and `npm run`), otherwise as `npm` from PATH (through the shell on Windows).
3. **Wrapper** in `appDir`, using the first `node` (`node.exe` on Windows) on PATH, else `process.execPath`:
   - macOS/Linux `native-host`: `#!/bin/sh` + `exec "<node>" "<pkgDir>/host/src/native-host.js" "$@"`, mode 0755.
   - Windows `native-host.cmd`: `@echo off` + `"<node>" "<pkgDir>\host\src\native-host.js" %*`, CRLF line endings.
4. **Windows pipe name.** If `<appDir>\pipe-name` does not exist, write `\\.\pipe\claude-firefox-bridge-<32 random hex chars>` to it; an existing file is kept.
5. **Native messaging manifest** `{ name: "claude_firefox_bridge", description: "Claude Code Bridge for Firefox", path: <wrapper>, type: "stdio", allowed_extensions: ["claude-firefox-bridge@local"] }`:
   - macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json`
   - Linux: `~/.mozilla/native-messaging-hosts/claude_firefox_bridge.json`
   - Windows: `<appDir>\claude_firefox_bridge.json`, plus `reg add "HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_bridge" /ve /t REG_SZ /d "<manifest path>" /f`.
6. **Legacy layout.** `<appDir>/host` (0.1/0.2 installs) is removed.
7. **Claude Code.** Unless `--no-claude`, when a `claude` executable is on PATH: run `claude mcp remove --scope user firefox` (failure ignored), then `claude mcp add --scope user firefox -- "<node>" "<pkgDir>/host/src/cli.js" mcp`. Without `claude`, print that command instead.
8. **Summary.** Print the manifest path, appDir, what happened with Claude Code, and a JSON snippet for other MCP clients: `{ "mcpServers": { "firefox": { "command": "<node>", "args": ["<pkgDir>/host/src/cli.js", "mcp"] } } }`.

Updating is `npx @llyfn/claude-in-firefox@latest install`, which replaces the copy and re-registers.

## 4. Uninstall

Unless `--no-claude`, when `claude` is on PATH: `claude mcp remove --scope user firefox` (a missing entry is not an error). On Windows: `reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_bridge" /f` (a missing key is not an error). Remove the native messaging manifest and `appDir`. Print each thing removed, and say when there was nothing to remove.

## 5. Transport

- `bridgeAddress({ platform, appDir })` in `paths.js`:
  - macOS/Linux: `/tmp/claude-firefox-bridge-<uid>/bridge.sock`, unchanged, with the existing directory checks.
  - Windows: the contents of `<appDir>\pipe-name`. A missing file is an error that says to run `claude-firefox install`.
- Windows has no equivalent of the socket directory's 0700 permissions, and Node cannot set a named pipe's access list. The default pipe permissions grant everyone read access, and any local user could create a known pipe name first and pose as the host. The unguessable name, kept in a file only the user (plus SYSTEM and administrators) can read, prevents both.
- Native host on Windows: no directory checks, `chmod`, or stale-socket cleanup (pipes disappear with their process). `EADDRINUSE` reports `Another native host is already serving <address>`.
- MCP server on Windows: no directory verification; a missing pipe-name file or a refused connection gives the existing not-connected message, which also mentions `claude-firefox install`.

## 6. CI and release

- New `.github/workflows/ci.yml` on pull requests and pushes to `main`:
  - `unit`: matrix ubuntu-latest, macos-latest, windows-latest, Node 24: `npm ci`, `npm test`; `npm run lint` on Ubuntu only.
  - `e2e`: matrix ubuntu-latest (under `xvfb-run`) and windows-latest: download Firefox Developer Edition from Mozilla (Linux tarball; Windows installer run silently), `npm ci`, `npm run install-host -- --no-claude`, `npm run e2e` with `FIREFOX_BIN` set.
- E2E harness: probe `bridgeAddress()` instead of `SOCKET_PATH`, and default `FIREFOX_BIN` per platform.
- `release.yml`: the tag must match both `extension/manifest.json` and `package.json`; after tests, lint and AMO signing, `npm publish --access public` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (setup-node `registry-url: https://registry.npmjs.org`), then the GitHub release.

## 7. Docs

README sections: Install (signed `.xpi`, then `npx @llyfn/claude-in-firefox install`), Update, Uninstall, Other MCP clients (Claude Desktop config file per OS and the generic `mcpServers` JSON), Windows notes (registry key, pipe-name file), Development (clone, `npm run install-host`), Releasing (`NPM_TOKEN` alongside the AMO keys). Requirements: macOS, Linux or Windows; Node ≥ 20 to run.

## Testing

- Unit: CLI argument parsing and usage; install and uninstall per platform with `npm`, `claude` and `reg` calls faked (commands and arguments asserted), wrapper contents, manifest contents, pipe-name creation and reuse, legacy cleanup, `--no-claude`; `bridgeAddress` per platform; native host and MCP server use the Windows pipe without directory checks.
- E2E: unchanged tests, now run locally on macOS and in CI on Linux and Windows through the real install.

## Verify during implementation

- Firefox on Windows launches a `.cmd` native host and stdio works in both directions; node exits when Firefox closes the host.
- `npm_execpath` is set under `npx` on all three platforms.
- `claude mcp add` arguments with spaces survive on Windows.
- Firefox Developer Edition installs silently on windows-latest, and where its `firefox.exe` lands.
- `web-ext run` and WebDriver BiDi work on the Linux and Windows runners.
