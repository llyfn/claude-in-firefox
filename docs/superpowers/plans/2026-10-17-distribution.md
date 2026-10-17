# Distribution and Platforms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the bridge as the npm package `@llyfn/claude-in-firefox` with a `claude-firefox` CLI that installs a pinned copy, registers with Claude Code, uninstalls cleanly, and works on Windows, with CI on all three platforms and npm publishing on release.

**Architecture:** `paths.js` gains per-platform app directories and a `bridgeAddress()` that is the Unix socket on macOS/Linux and a secret-named pipe on Windows. `install.js` is rewritten around an injected `run(command, args, options)` so npm, `claude` and `reg` calls are testable. A new `cli.js` dispatches `install`, `uninstall` and `mcp`. CI runs unit tests on three OSes and e2e on Linux and Windows.

**Tech Stack:** Node ≥ 20 at runtime (≥ 22.22 for development), `node:test`, npm, GitHub Actions, Firefox Developer Edition, `web-ext`.

**Spec:** `docs/superpowers/specs/2026-10-17-distribution-design.md`

## Global Constraints

- ES modules; no new dependencies. Comments only for constraints the code cannot show; none about the change itself.
- Plain commit messages after each task; no AI attribution, co-author trailers or session links.
- Package name `@llyfn/claude-in-firefox`; command `claude-firefox`; native host name `claude_firefox_bridge`; extension id `claude-firefox-bridge@local`.
- App directories: macOS `~/Library/Application Support/claude-in-firefox`, Linux `~/.local/share/claude-in-firefox`, Windows `%LOCALAPPDATA%\claude-in-firefox` (fallback `<home>\AppData\Local\claude-in-firefox`). Package copy at `<appDir>/node_modules/@llyfn/claude-in-firefox`.
- Registry key `HKCU\Software\Mozilla\NativeMessagingHosts\claude_firefox_bridge`. Pipe-name file `<appDir>\pipe-name` holding `\\.\pipe\claude-firefox-bridge-<32 lowercase hex>`.
- Filesystem paths are built with Node's native `path` (so unit tests can simulate `win32` on macOS/Linux without writing backslash-named files); the platform argument only selects behavior.
- Never publish to npm, never push to `main`, never force-push. Tasks 4 and 5 may push the `feat/distribution` branch to `origin` to run CI.
- `npm test` and `npm run lint` pass after every task; `npm run e2e` (macOS, local) passes after Tasks 5 and 6.

## Review Focus

1. Installing from a repo clone must use `npm pack` + the tarball (never a symlinked folder install), and from a published package must use `@llyfn/claude-in-firefox@<its own version>` (Task 2 tests "install from a clone packs it…" and "install from a published copy…").
2. A second `install` on Windows keeps the existing pipe name, so a running Firefox and Claude Code stay in sync (Task 2 test "the Windows pipe name is created once and kept").
3. `--no-claude` never touches Claude Code even when `claude` is on PATH (Task 2 test "--no-claude leaves Claude Code alone").
4. Uninstall with nothing installed reports that and does not fail (Task 2 test "uninstall reports when there is nothing to remove").
5. A missing or malformed pipe-name file surfaces as "not connected … run install", not a crash of the MCP server (Task 1 tests "an address that cannot be resolved reads as not connected" and the bridgeAddress test).

---

### Task 1: Platform paths and the Windows transport

**Files:**
- Modify: `host/src/paths.js`
- Modify: `host/src/native-host.js`
- Modify: `host/src/mcp-server.js`
- Test: `test/unit/paths.test.js`, `test/unit/native-host.test.js`, `test/unit/mcp-server.test.js`

**Interfaces:**
- Produces (paths.js): `PACKAGE_NAME`, `PACKAGE_VERSION`, `PIPE_NAME_FILE`, `REGISTRY_KEY`, `appDirFor(homeDir = os.homedir(), platform = process.platform, env = process.env)`, `nativeManifestPath(homeDir = os.homedir(), platform = process.platform, env = process.env)`, `packageDirFor(appDir)`, `bridgeAddress({ platform = process.platform, appDir } = {})`. `installLocations` stays until Task 2 removes it.
- Produces (native-host.js): `startNativeHost({ input, output, address, platform = process.platform })`.
- Produces (mcp-server.js): `new BridgeClient({ address, sessionId, platform = process.platform })` where `address` is a string or a function returning one; `runMcpServer()`; `NOT_CONNECTED_MESSAGE` = `Firefox extension not connected — is Firefox running with the Claude Code Bridge for Firefox add-on installed, and has \`npx @llyfn/claude-in-firefox install\` been run?`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/paths.test.js` (add the new names to its import):

```js
test("app directories, manifest paths and the package copy are per platform", () => {
  assert.equal(appDirFor("/home/u", "darwin"), path.join("/home/u", "Library/Application Support/claude-in-firefox"));
  assert.equal(appDirFor("/home/u", "linux"), path.join("/home/u", ".local/share/claude-in-firefox"));
  assert.equal(appDirFor("/home/u", "win32", { LOCALAPPDATA: "/la" }), path.join("/la", "claude-in-firefox"));
  assert.equal(appDirFor("/home/u", "win32", {}), path.join("/home/u", "AppData", "Local", "claude-in-firefox"));
  assert.throws(() => appDirFor("/home/u", "aix"), /Unsupported platform "aix": supported platforms are macOS, Linux and Windows/);
  assert.equal(nativeManifestPath("/home/u", "darwin"), path.join("/home/u", "Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json"));
  assert.equal(nativeManifestPath("/home/u", "linux"), path.join("/home/u", ".mozilla/native-messaging-hosts/claude_firefox_bridge.json"));
  assert.equal(nativeManifestPath("/home/u", "win32", { LOCALAPPDATA: "/la" }), path.join("/la", "claude-in-firefox", "claude_firefox_bridge.json"));
  assert.equal(packageDirFor("/app"), path.join("/app", "node_modules", "@llyfn", "claude-in-firefox"));
  assert.equal(REGISTRY_KEY, "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\claude_firefox_bridge");
  assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+$/);
});

test("on macOS and Linux the bridge is the per-user Unix socket", () => {
  assert.equal(bridgeAddress({ platform: "linux", appDir: "/nowhere" }), SOCKET_PATH);
  assert.equal(bridgeAddress({ platform: "darwin", appDir: "/nowhere" }), SOCKET_PATH);
});

test("on Windows the bridge is the pipe named in the app directory, and a missing or malformed name says to install", () => {
  const appDir = tempRoot();
  const pipe = `\\\\.\\pipe\\claude-firefox-bridge-${"a1".repeat(16)}`;
  assert.throws(() => bridgeAddress({ platform: "win32", appDir }), /No valid bridge pipe name in .*pipe-name\. Run `npx @llyfn\/claude-in-firefox install`\./);
  fs.writeFileSync(path.join(appDir, "pipe-name"), `${pipe}\r\n`);
  assert.equal(bridgeAddress({ platform: "win32", appDir }), pipe);
  fs.writeFileSync(path.join(appDir, "pipe-name"), "\\\\.\\pipe\\something-else\n");
  assert.throws(() => bridgeAddress({ platform: "win32", appDir }), /No valid bridge pipe name/);
});
```

In `test/unit/native-host.test.js`: rename the `socketPath` option to `address` everywhere it is passed to `startNativeHost` (keep the local variable names), and append:

```js
test("with the Windows transport the host skips directory checks and reports a busy address", async (t) => {
  const dir = fs.mkdtempSync("/tmp/cfb-win-");
  fs.chmodSync(dir, 0o755);
  const address = path.join(dir, "bridge.sock");
  const first = await startNativeHost({ input: new PassThrough(), output: new PassThrough(), address, platform: "win32" });
  t.after(() => first.close());
  await assert.rejects(startNativeHost({ input: new PassThrough(), output: new PassThrough(), address, platform: "win32" }), { message: `Another native host is already serving ${address}` });
});
```

In `test/unit/mcp-server.test.js`: rename `socketPath:` to `address:` in every `new BridgeClient({...})`, and append:

```js
test("with the Windows transport the client skips directory checks", async (t) => {
  const dir = fs.mkdtempSync("/tmp/cfb-win-");
  fs.chmodSync(dir, 0o755);
  const address = path.join(dir, "bridge.sock");
  const host = await fakeHost(address, (msg, reply) => reply({ type: "result", id: msg.id, content: [{ type: "text", text: "ok" }], isError: false }));
  const client = new BridgeClient({ address, sessionId: "s", platform: "win32" });
  t.after(async () => { client.close(); await host.close(); });
  assert.deepEqual(await client.call("tabs_create", {}, 1000), { content: [{ type: "text", text: "ok" }], isError: false });
});

test("an address that cannot be resolved reads as not connected", async () => {
  const client = new BridgeClient({ address: () => { throw new Error("No valid bridge pipe name in X."); }, sessionId: "s" });
  await assert.rejects(client.call("tabs_create", {}, 1000), { message: `${NOT_CONNECTED_MESSAGE} (No valid bridge pipe name in X.)` });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `appDirFor`/`bridgeAddress` are not exported; `startNativeHost` ignores `address`; `BridgeClient` ignores `address`.

- [ ] **Step 3: Implement**

In `host/src/paths.js` add (after `SOCKET_PATH`):

```js
export const PACKAGE_NAME = "@llyfn/claude-in-firefox";
export const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const PIPE_NAME_FILE = "pipe-name";
export const REGISTRY_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
const PIPE_NAME = /^\\\\\.\\pipe\\claude-firefox-bridge-[0-9a-f]{32}$/;

export function appDirFor(homeDir = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === "darwin") return path.join(homeDir, "Library/Application Support/claude-in-firefox");
  if (platform === "linux") return path.join(homeDir, ".local/share/claude-in-firefox");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "claude-in-firefox");
  throw new Error(`Unsupported platform "${platform}": supported platforms are macOS, Linux and Windows.`);
}

export function nativeManifestPath(homeDir = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === "darwin") return path.join(homeDir, "Library/Application Support/Mozilla/NativeMessagingHosts", `${HOST_NAME}.json`);
  if (platform === "linux") return path.join(homeDir, ".mozilla/native-messaging-hosts", `${HOST_NAME}.json`);
  return path.join(appDirFor(homeDir, platform, env), `${HOST_NAME}.json`);
}

export const packageDirFor = (appDir) => path.join(appDir, "node_modules", "@llyfn", "claude-in-firefox");

// Node cannot restrict a named pipe to one user, so on Windows the pipe's name is a secret kept in the user's profile.
export function bridgeAddress({ platform = process.platform, appDir = appDirFor(os.homedir(), platform) } = {}) {
  if (platform !== "win32") return SOCKET_PATH;
  const file = path.join(appDir, PIPE_NAME_FILE);
  let name = "";
  try {
    name = fs.readFileSync(file, "utf8").trim();
  } catch {}
  if (!PIPE_NAME.test(name)) throw new Error(`No valid bridge pipe name in ${file}. Run \`npx ${PACKAGE_NAME} install\`.`);
  return name;
}
```

Delete the existing `nativeManifestPath` (the new one above replaces it; its two-argument calls keep working). Keep `installLocations` for now.

In `host/src/native-host.js`:
- import `bridgeAddress` instead of `SOCKET_PATH`;
- change the signature to `export async function startNativeHost({ input, output, address, platform = process.platform })` and replace every use of `socketPath` in the function with `address`;
- guard the Unix-only steps with `const unix = platform !== "win32";`: `if (unix) { await ensureSocketDir(path.dirname(address)); await claimSocketPath(address); }`, `if (unix) await fsp.chmod(address, 0o600);`, and in `close` `if (unix) fs.rmSync(address, { force: true });`;
- replace the listen promise with:

```js
  await new Promise((resolve, reject) => {
    server.once("error", (err) => reject(err.code === "EADDRINUSE" ? new Error(`Another native host is already serving ${address}`) : err));
    server.listen(address, resolve);
  });
```

- in the `isMain` block use `startNativeHost({ input: process.stdin, output: process.stdout, address: bridgeAddress() })` (inside the existing try).

In `host/src/mcp-server.js`:
- import `bridgeAddress` instead of `SOCKET_PATH`;
- `export const NOT_CONNECTED_MESSAGE = "Firefox extension not connected — is Firefox running with the Claude Code Bridge for Firefox add-on installed, and has `npx @llyfn/claude-in-firefox install` been run?";` (use a template literal or escape the backticks);
- in `BridgeClient` replace `#socketPath` with `#address` and `#platform`, and the constructor with:

```js
  constructor({ address, sessionId, platform = process.platform }) {
    this.#address = typeof address === "function" ? address : () => address;
    this.#platform = platform;
    this.sessionId = sessionId;
  }
```

- start `#open()` with:

```js
    let address;
    try {
      address = this.#address();
    } catch (err) {
      throw new Error(`${NOT_CONNECTED_MESSAGE} (${err.message})`);
    }
    if (this.#platform !== "win32") {
      try {
        await verifySocketDir(path.dirname(address));
      } catch (err) {
        throw new Error(err.code === "ENOENT" ? NOT_CONNECTED_MESSAGE : err.message);
      }
    }
    const socket = net.connect(address);
```

(and remove the old `verifySocketDir` block and `net.connect(this.#socketPath)`);
- replace the `isMain` block with:

```js
export async function runMcpServer() {
  const bridge = new BridgeClient({ address: () => bridgeAddress(), sessionId: randomUUID() });
  await createMcpServer({ bridge }).connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));
}

if (isMain(import.meta.url)) await runMcpServer();
```

- in `createMcpServer` use `PACKAGE_VERSION` (imported from `./paths.js`) as the server version.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/src/paths.js host/src/native-host.js host/src/mcp-server.js test/unit/paths.test.js test/unit/native-host.test.js test/unit/mcp-server.test.js
git commit -m "Resolve the bridge address per platform, with a secret pipe name on Windows"
```

---

### Task 2: Installer and uninstaller

**Files:**
- Rewrite: `host/src/install.js`
- Modify: `host/src/paths.js` (remove `installLocations`)
- Rewrite: `test/unit/install.test.js`

**Interfaces:**
- Consumes: Task 1's paths API.
- Produces: `install({ homeDir, platform, env, nodePath, packageRoot, run, claude = true })` → `{ appDir, pkgDir, manifestPath, wrapperPath, claudeStatus: "registered" | "not-found" | "skipped", claudeCommand, mcpConfig }`; `uninstall({ homeDir, platform, env, run, claude = true })` → `{ removed: string[] }`; `runCommand(command, args, { cwd })` → `{ stdout, stderr }`; `findExecutable(name, env, platform)` → path or `null`; `stableNodePath(env, platform)`. `install.js` no longer has an `isMain` block (Task 3's CLI calls it).

- [ ] **Step 1: Write the failing tests**

Replace `test/unit/install.test.js` with:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable, install, runCommand, stableNodePath, uninstall } from "../../host/src/install.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cfb-install-"));
const PIPE = /^\\\\\.\\pipe\\claude-firefox-bridge-[0-9a-f]{32}\n$/;

function fakeRun({ failing = [] } = {}) {
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command: path.basename(command), args, cwd: options.cwd });
    if (failing.some((f) => [command, ...args].join(" ").includes(f))) throw new Error(`${command} failed`);
    if (args.includes("pack")) return { stdout: `llyfn-claude-in-firefox-${VERSION}.tgz\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
}

function binDir(...names) {
  const dir = tmp();
  for (const name of names) fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

test("install from a clone packs it, installs the tarball into the app directory, writes the wrapper and manifest, and registers with Claude Code", async () => {
  const home = tmp();
  const { run, calls } = fakeRun();
  const env = { PATH: binDir("claude"), npm_execpath: "/npm/bin/npm-cli.js" };
  const result = await install({ homeDir: home, platform: "darwin", env, nodePath: "/opt/node/bin/node", packageRoot: REPO, run });

  const appDir = path.join(home, "Library/Application Support/claude-in-firefox");
  const pkgDir = path.join(appDir, "node_modules/@llyfn/claude-in-firefox");
  const cli = path.join(pkgDir, "host/src/cli.js");
  assert.equal(result.appDir, appDir);
  assert.equal(result.pkgDir, pkgDir);

  const [pack, npmInstall, remove, add, ...rest] = calls;
  assert.equal(rest.length, 0);
  assert.equal(pack.command, path.basename(process.execPath));
  assert.deepEqual(pack.args.slice(0, 3), ["/npm/bin/npm-cli.js", "pack", "--pack-destination"]);
  assert.equal(pack.cwd, REPO);
  assert.deepEqual(npmInstall.args.slice(0, -1), ["/npm/bin/npm-cli.js", "install", "--prefix", appDir, "--omit=dev", "--no-audit", "--no-fund"]);
  assert.equal(npmInstall.args.at(-1), path.join(pack.args[3], `llyfn-claude-in-firefox-${VERSION}.tgz`));
  assert.equal(fs.existsSync(pack.args[3]), false);
  assert.deepEqual([remove.command, ...remove.args], ["claude", "mcp", "remove", "--scope", "user", "firefox"]);
  assert.deepEqual([add.command, ...add.args], ["claude", "mcp", "add", "--scope", "user", "firefox", "--", "/opt/node/bin/node", cli, "mcp"]);
  assert.equal(result.claudeStatus, "registered");

  assert.equal(result.wrapperPath, path.join(appDir, "native-host"));
  assert.equal(fs.readFileSync(result.wrapperPath, "utf8"), `#!/bin/sh\nexec "/opt/node/bin/node" "${path.join(pkgDir, "host/src/native-host.js")}" "$@"\n`);
  assert.equal(fs.statSync(result.wrapperPath).mode & 0o777, 0o755);
  assert.equal(result.manifestPath, path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")), {
    name: "claude_firefox_bridge",
    description: "Claude Code Bridge for Firefox",
    path: result.wrapperPath,
    type: "stdio",
    allowed_extensions: ["claude-firefox-bridge@local"],
  });
  assert.deepEqual(result.mcpConfig, { mcpServers: { firefox: { command: "/opt/node/bin/node", args: [cli, "mcp"] } } });
  assert.equal(result.claudeCommand, `claude mcp add --scope user firefox -- "/opt/node/bin/node" "${cli}" mcp`);
});

test("install from a published copy installs its own version from the registry", async () => {
  const root = path.join(tmp(), "node_modules/@llyfn/claude-in-firefox");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@llyfn/claude-in-firefox", version: "9.9.9" }));
  const { run, calls } = fakeRun();
  await install({ homeDir: tmp(), platform: "linux", env: { PATH: "", npm_execpath: "/npm/bin/npm-cli.js" }, nodePath: "/usr/bin/node", packageRoot: root, run, claude: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), "@llyfn/claude-in-firefox@9.9.9");
});

test("npx's execpath is swapped for npm's, and without one npm is found on PATH", async () => {
  const first = fakeRun();
  await install({ homeDir: tmp(), platform: "linux", env: { PATH: "", npm_execpath: "/npm/bin/npx-cli.js" }, nodePath: "/usr/bin/node", packageRoot: REPO, run: first.run, claude: false });
  assert.equal(first.calls[0].args[0], path.join("/npm/bin", "npm-cli.js"));
  const second = fakeRun();
  await install({ homeDir: tmp(), platform: "linux", env: { PATH: binDir("npm") }, nodePath: "/usr/bin/node", packageRoot: REPO, run: second.run, claude: false });
  assert.deepEqual([second.calls[0].command, second.calls[0].args[0]], ["npm", "pack"]);
  await assert.rejects(install({ homeDir: tmp(), platform: "linux", env: { PATH: "" }, nodePath: "/usr/bin/node", packageRoot: REPO, run: fakeRun().run, claude: false }), /npm was not found on PATH/);
});

test("--no-claude leaves Claude Code alone, and a missing claude prints the command instead", async () => {
  const skipped = fakeRun();
  const env = { PATH: binDir("claude"), npm_execpath: "/npm/bin/npm-cli.js" };
  const a = await install({ homeDir: tmp(), platform: "linux", env, nodePath: "/usr/bin/node", packageRoot: REPO, run: skipped.run, claude: false });
  assert.equal(a.claudeStatus, "skipped");
  assert.equal(skipped.calls.some((c) => c.command === "claude"), false);
  const missing = fakeRun();
  const b = await install({ homeDir: tmp(), platform: "linux", env: { PATH: "", npm_execpath: "/npm/bin/npm-cli.js" }, nodePath: "/usr/bin/node", packageRoot: REPO, run: missing.run });
  assert.equal(b.claudeStatus, "not-found");
  assert.match(b.claudeCommand, /^claude mcp add --scope user firefox -- "\/usr\/bin\/node" ".*cli\.js" mcp$/);
});

test("a failing claude mcp remove is ignored but a failing add is reported", async () => {
  const env = { PATH: binDir("claude"), npm_execpath: "/npm/bin/npm-cli.js" };
  const ok = await install({ homeDir: tmp(), platform: "linux", env, nodePath: "/usr/bin/node", packageRoot: REPO, run: fakeRun({ failing: ["mcp remove"] }).run });
  assert.equal(ok.claudeStatus, "registered");
  await assert.rejects(install({ homeDir: tmp(), platform: "linux", env, nodePath: "/usr/bin/node", packageRoot: REPO, run: fakeRun({ failing: ["mcp add"] }).run }), /failed/);
});

test("on Linux the app directory is under ~/.local/share and the manifest under ~/.mozilla", async () => {
  const home = tmp();
  const result = await install({ homeDir: home, platform: "linux", env: { PATH: "", npm_execpath: "/n/npm-cli.js" }, nodePath: "/usr/bin/node", packageRoot: REPO, run: fakeRun().run, claude: false });
  assert.equal(result.appDir, path.join(home, ".local/share/claude-in-firefox"));
  assert.equal(result.manifestPath, path.join(home, ".mozilla/native-messaging-hosts/claude_firefox_bridge.json"));
});

test("on Windows install writes a .cmd wrapper, the pipe name and the manifest in the app directory, and registers the manifest in the registry", async () => {
  const local = tmp();
  const { run, calls } = fakeRun();
  const env = { PATH: "", LOCALAPPDATA: local, npm_execpath: "C:/npm/npm-cli.js" };
  const result = await install({ homeDir: tmp(), platform: "win32", env, nodePath: "C:\\node\\node.exe", packageRoot: REPO, run, claude: false });
  const appDir = path.join(local, "claude-in-firefox");
  assert.equal(result.wrapperPath, path.join(appDir, "native-host.cmd"));
  assert.equal(fs.readFileSync(result.wrapperPath, "utf8"), `@echo off\r\n"C:\\node\\node.exe" "${path.join(result.pkgDir, "host/src/native-host.js")}" %*\r\n`);
  assert.match(fs.readFileSync(path.join(appDir, "pipe-name"), "utf8"), PIPE);
  assert.equal(result.manifestPath, path.join(appDir, "claude_firefox_bridge.json"));
  assert.deepEqual([calls.at(-1).command, ...calls.at(-1).args], ["reg", "add", "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\claude_firefox_bridge", "/ve", "/t", "REG_SZ", "/d", result.manifestPath, "/f"]);
});

test("the Windows pipe name is created once and kept", async () => {
  const local = tmp();
  const env = { PATH: "", LOCALAPPDATA: local, npm_execpath: "C:/npm/npm-cli.js" };
  const options = { homeDir: tmp(), platform: "win32", env, nodePath: "node.exe", packageRoot: REPO, claude: false };
  await install({ ...options, run: fakeRun().run });
  const first = fs.readFileSync(path.join(local, "claude-in-firefox/pipe-name"), "utf8");
  await install({ ...options, run: fakeRun().run });
  assert.equal(fs.readFileSync(path.join(local, "claude-in-firefox/pipe-name"), "utf8"), first);
});

test("install removes the host folder left by 0.1 and 0.2", async () => {
  const home = tmp();
  const legacy = path.join(home, ".local/share/claude-in-firefox/host");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "native-host.js"), "");
  await install({ homeDir: home, platform: "linux", env: { PATH: "", npm_execpath: "/n/npm-cli.js" }, nodePath: "/usr/bin/node", packageRoot: REPO, run: fakeRun().run, claude: false });
  assert.equal(fs.existsSync(legacy), false);
});

test("uninstall removes the Claude Code entry, the manifest and the app directory", async () => {
  const home = tmp();
  const env = { PATH: binDir("claude"), npm_execpath: "/n/npm-cli.js" };
  const installed = await install({ homeDir: home, platform: "linux", env, nodePath: "/usr/bin/node", packageRoot: REPO, run: fakeRun().run, claude: false });
  const { run, calls } = fakeRun();
  const { removed } = await uninstall({ homeDir: home, platform: "linux", env, run });
  assert.deepEqual(calls.map((c) => [c.command, ...c.args]), [["claude", "mcp", "remove", "--scope", "user", "firefox"]]);
  assert.deepEqual(removed, ['Claude Code MCP server "firefox"', installed.manifestPath, installed.appDir]);
  assert.equal(fs.existsSync(installed.appDir), false);
  assert.equal(fs.existsSync(installed.manifestPath), false);
});

test("uninstall on Windows deletes the registry key, and --no-claude skips Claude Code", async () => {
  const local = tmp();
  const env = { PATH: binDir("claude.cmd"), PATHEXT: ".EXE;.CMD", LOCALAPPDATA: local, npm_execpath: "C:/npm/npm-cli.js" };
  await install({ homeDir: tmp(), platform: "win32", env, nodePath: "node.exe", packageRoot: REPO, run: fakeRun().run, claude: false });
  const { run, calls } = fakeRun();
  const { removed } = await uninstall({ homeDir: tmp(), platform: "win32", env, run, claude: false });
  assert.deepEqual(calls.map((c) => [c.command, ...c.args]), [["reg", "delete", "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\claude_firefox_bridge", "/f"]]);
  assert.deepEqual(removed, ["registry key HKCU\\Software\\Mozilla\\NativeMessagingHosts\\claude_firefox_bridge", path.join(local, "claude-in-firefox")]);
});

test("uninstall reports when there is nothing to remove", async () => {
  const { removed } = await uninstall({ homeDir: tmp(), platform: "linux", env: { PATH: binDir("claude") }, run: fakeRun({ failing: ["mcp remove"] }).run });
  assert.deepEqual(removed, []);
});

test("findExecutable checks PATH, with PATHEXT on Windows", () => {
  const unix = binDir("claude");
  assert.equal(findExecutable("claude", { PATH: ["relative", unix].join(path.delimiter) }, "linux"), path.join(unix, "claude"));
  assert.equal(findExecutable("claude", { PATH: "" }, "linux"), null);
  const win = binDir("claude.cmd");
  assert.equal(findExecutable("claude", { PATH: win, PATHEXT: ".EXE;.CMD" }, "win32"), path.join(win, "claude.cmd"));
});

test("stableNodePath returns the first executable node on PATH without resolving symlinks and falls back to the running node", () => {
  const root = tmp();
  const real = path.join(root, "Cellar/node/1.0/bin");
  const stable = path.join(root, "bin");
  const noExec = path.join(root, "noexec");
  for (const dir of [real, stable, noExec]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(real, "node"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(path.join(real, "node"), path.join(stable, "node"));
  fs.writeFileSync(path.join(noExec, "node"), "", { mode: 0o644 });
  assert.equal(stableNodePath({ PATH: ["relative", path.join(root, "missing"), noExec, stable, real].join(path.delimiter) }, "linux"), path.join(stable, "node"));
  assert.equal(stableNodePath({ PATH: path.join(root, "missing") }, "linux"), process.execPath);
  const win = binDir("node.exe");
  assert.equal(stableNodePath({ PATH: win }, "win32"), path.join(win, "node.exe"));
});

test("runCommand resolves with output and rejects with the command's error text", async () => {
  assert.equal((await runCommand(process.execPath, ["-e", "console.log('hi')"])).stdout, "hi\n");
  await assert.rejects(runCommand(process.execPath, ["-e", "console.error('nope'); process.exit(3)"]), /failed: nope/);
});

test("unsupported platforms are refused before anything is written", async () => {
  const home = tmp();
  await assert.rejects(install({ homeDir: home, platform: "aix", env: { PATH: "" }, nodePath: "node", packageRoot: REPO, run: fakeRun().run }), /Unsupported platform "aix"/);
  assert.deepEqual(fs.readdirSync(home), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/unit/install.test.js`
Expected: FAIL — `install` is synchronous and has no `run`/`uninstall`/`findExecutable`/`runCommand`.

- [ ] **Step 3: Implement**

Replace `host/src/install.js` with:

```js
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, HOST_NAME, PACKAGE_NAME, PIPE_NAME_FILE, REGISTRY_KEY, appDirFor, nativeManifestPath, packageDirFor } from "./paths.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MCP_NAME = "firefox";

const quoteForCmd = (arg) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`);

export function runCommand(command, args, { cwd } = {}) {
  // Windows runs .cmd and .bat files only through the shell, which needs the arguments quoted for cmd.exe.
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const file = viaShell ? quoteForCmd(command) : command;
  const argv = viaShell ? args.map(quoteForCmd) : args;
  return new Promise((resolve, reject) => {
    execFile(file, argv, { cwd, shell: viaShell, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(command)} ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function findExecutable(name, env = process.env, platform = process.platform) {
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => ext.toLowerCase()) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

// process.execPath is the versioned Cellar path under Homebrew, which `brew upgrade node` deletes. The first `node` on PATH is the stable symlink.
export function stableNodePath(env = process.env, platform = process.platform) {
  return findExecutable("node", { ...env, PATHEXT: ".EXE" }, platform) ?? process.execPath;
}

function npm(run, env, platform, args, options) {
  if (env.npm_execpath) {
    const cli = path.basename(env.npm_execpath) === "npx-cli.js" ? path.join(path.dirname(env.npm_execpath), "npm-cli.js") : env.npm_execpath;
    return run(process.execPath, [cli, ...args], options);
  }
  const npmPath = findExecutable("npm", env, platform);
  if (!npmPath) throw new Error("npm was not found on PATH");
  return run(npmPath, args, options);
}

const isInstalledPackage = (root) => root.split(/[\\/]/).includes("node_modules");

async function installPackage({ appDir, packageRoot, run, env, platform }) {
  const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (isInstalledPackage(packageRoot)) {
    await npm(run, env, platform, ["install", "--prefix", appDir, "--omit=dev", "--no-audit", "--no-fund", `${PACKAGE_NAME}@${version}`]);
    return;
  }
  // A folder install would symlink the clone; a packed tarball installs exactly what users get.
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-firefox-pack-"));
  try {
    const { stdout } = await npm(run, env, platform, ["pack", "--pack-destination", packDir, "--silent"], { cwd: packageRoot });
    const tarball = path.join(packDir, stdout.trim().split(/\r?\n/).pop());
    await npm(run, env, platform, ["install", "--prefix", appDir, "--omit=dev", "--no-audit", "--no-fund", tarball]);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
}

export async function install({ homeDir = os.homedir(), platform = process.platform, env = process.env, nodePath = stableNodePath(env, platform), packageRoot = PACKAGE_ROOT, run = runCommand, claude = true } = {}) {
  const appDir = appDirFor(homeDir, platform, env);
  const manifestPath = nativeManifestPath(homeDir, platform, env);
  const pkgDir = packageDirFor(appDir);
  const cliScript = path.join(pkgDir, "host", "src", "cli.js");
  const hostScript = path.join(pkgDir, "host", "src", "native-host.js");
  fs.mkdirSync(appDir, { recursive: true });
  await installPackage({ appDir, packageRoot, run, env, platform });

  let wrapperPath;
  if (platform === "win32") {
    wrapperPath = path.join(appDir, "native-host.cmd");
    fs.writeFileSync(wrapperPath, `@echo off\r\n"${nodePath}" "${hostScript}" %*\r\n`);
    const pipeFile = path.join(appDir, PIPE_NAME_FILE);
    if (!fs.existsSync(pipeFile)) fs.writeFileSync(pipeFile, `\\\\.\\pipe\\claude-firefox-bridge-${randomBytes(16).toString("hex")}\n`);
  } else {
    wrapperPath = path.join(appDir, "native-host");
    fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${nodePath}" "${hostScript}" "$@"\n`);
    fs.chmodSync(wrapperPath, 0o755);
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = { name: HOST_NAME, description: "Claude Code Bridge for Firefox", path: wrapperPath, type: "stdio", allowed_extensions: [EXTENSION_ID] };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (platform === "win32") await run("reg", ["add", REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);

  fs.rmSync(path.join(appDir, "host"), { recursive: true, force: true });

  const mcpArgs = [nodePath, cliScript, "mcp"];
  const claudeCommand = `claude mcp add --scope user ${MCP_NAME} -- "${nodePath}" "${cliScript}" mcp`;
  const claudePath = claude ? findExecutable("claude", env, platform) : null;
  let claudeStatus = claude ? "not-found" : "skipped";
  if (claudePath) {
    await run(claudePath, ["mcp", "remove", "--scope", "user", MCP_NAME]).catch(() => {});
    await run(claudePath, ["mcp", "add", "--scope", "user", MCP_NAME, "--", ...mcpArgs]);
    claudeStatus = "registered";
  }

  return { appDir, pkgDir, manifestPath, wrapperPath, claudeStatus, claudeCommand, mcpConfig: { mcpServers: { [MCP_NAME]: { command: nodePath, args: [cliScript, "mcp"] } } } };
}

export async function uninstall({ homeDir = os.homedir(), platform = process.platform, env = process.env, run = runCommand, claude = true } = {}) {
  const removed = [];
  const claudePath = claude ? findExecutable("claude", env, platform) : null;
  if (claudePath && (await run(claudePath, ["mcp", "remove", "--scope", "user", MCP_NAME]).then(() => true, () => false))) removed.push(`Claude Code MCP server "${MCP_NAME}"`);
  if (platform === "win32" && (await run("reg", ["delete", REGISTRY_KEY, "/f"]).then(() => true, () => false))) removed.push(`registry key ${REGISTRY_KEY}`);
  const manifestPath = nativeManifestPath(homeDir, platform, env);
  const appDir = appDirFor(homeDir, platform, env);
  if (!manifestPath.startsWith(appDir) && fs.existsSync(manifestPath)) {
    fs.rmSync(manifestPath, { force: true });
    removed.push(manifestPath);
  }
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
    removed.push(appDir);
  }
  return { removed };
}
```

(`findExecutable` with `PATHEXT: ".EXE"` looks for `node.exe` on Windows and plain `node` elsewhere.)

In `host/src/paths.js` delete `installLocations`.

The order of the `appDirFor` call before `fs.mkdirSync` guarantees "unsupported platforms are refused before anything is written".

- [ ] **Step 4: Run to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS. (`package.json` still runs `node host/src/install.js` for `install-host`; that script now does nothing until Task 3 — do not run it in this task.)

- [ ] **Step 5: Commit**

```bash
git add host/src/install.js host/src/paths.js test/unit/install.test.js
git commit -m "Install a pinned copy with npm and register it with Claude Code; add uninstall"
```

---

### Task 3: The claude-firefox CLI and the npm package

**Files:**
- Create: `host/src/cli.js`
- Modify: `package.json`, `package-lock.json`
- Test: `test/unit/cli.test.js` (new)

**Interfaces:**
- Consumes: `install`, `uninstall` (Task 2), `runMcpServer` (Task 1), `PACKAGE_VERSION`, `isMain` (paths.js).
- Produces: `parseArgs(argv)` → `{ command: "help" | "version" | "mcp" | "install" | "uninstall" | "usage-error", claude? }`; `formatInstall(result)` and `formatUninstall(result)` → strings; `USAGE`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/cli.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USAGE, formatInstall, formatUninstall, parseArgs } from "../../host/src/cli.js";
import { PACKAGE_VERSION } from "../../host/src/paths.js";

const CLI = fileURLToPath(new URL("../../host/src/cli.js", import.meta.url));
const REPO = fileURLToPath(new URL("../../", import.meta.url));

test("arguments map to commands and anything else is a usage error", () => {
  assert.deepEqual(parseArgs(["install"]), { command: "install", claude: true });
  assert.deepEqual(parseArgs(["install", "--no-claude"]), { command: "install", claude: false });
  assert.deepEqual(parseArgs(["uninstall", "--no-claude"]), { command: "uninstall", claude: false });
  assert.deepEqual(parseArgs(["mcp"]), { command: "mcp" });
  assert.deepEqual(parseArgs(["--version"]), { command: "version" });
  assert.deepEqual(parseArgs(["--help"]), { command: "help" });
  for (const argv of [[], ["mcp", "x"], ["install", "--force"], ["serve"]]) assert.deepEqual(parseArgs(argv), { command: "usage-error" });
});

test("--version prints the package version and unknown commands print the usage with status 1", () => {
  const version = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${PACKAGE_VERSION}\n`);
  const bad = spawnSync(process.execPath, [CLI, "serve"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `${USAGE}\n`);
});

test("the install summary says what happened with Claude Code and shows the config for other clients", () => {
  const base = { appDir: "/app", manifestPath: "/m.json", claudeCommand: 'claude mcp add --scope user firefox -- "/node" "/app/cli.js" mcp', mcpConfig: { mcpServers: { firefox: { command: "/node", args: ["/app/cli.js", "mcp"] } } } };
  const registered = formatInstall({ ...base, claudeStatus: "registered" });
  assert.match(registered, /^Installed Claude Code Bridge for Firefox \d+\.\d+\.\d+\n/);
  assert.match(registered, /App directory: {5}\/app\n/);
  assert.match(registered, /Native messaging: {2}\/m\.json\n/);
  assert.match(registered, /Claude Code: registered the "firefox" MCP server\./);
  assert.match(registered, /"command": "\/node"/);
  assert.match(registered, /https:\/\/github\.com\/llyfn\/claude-in-firefox\/releases\/latest/);
  assert.match(formatInstall({ ...base, claudeStatus: "not-found" }), /Claude Code: `claude` was not found on PATH\. Register the server with:\n {2}claude mcp add/);
  assert.match(formatInstall({ ...base, claudeStatus: "skipped" }), /Claude Code: skipped \(--no-claude\)\. Register the server with:\n {2}claude mcp add/);
});

test("the uninstall summary lists what was removed", () => {
  assert.equal(formatUninstall({ removed: ["a", "b"] }), "Removed:\n  a\n  b");
  assert.equal(formatUninstall({ removed: [] }), "Nothing to remove: Claude Code Bridge for Firefox is not installed.");
});

test("the npm package ships the host and its CLI but not the extension or tests", () => {
  const args = ["pack", "--dry-run", "--json"];
  const pack = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: REPO, encoding: "utf8" })
    : spawnSync("npm", args, { cwd: REPO, encoding: "utf8", shell: process.platform === "win32" });
  const [{ name, files }] = JSON.parse(pack.stdout);
  const paths = files.map((f) => f.path);
  assert.equal(name, "@llyfn/claude-in-firefox");
  for (const expected of ["host/src/cli.js", "host/src/native-host.js", "host/src/mcp-server.js", "README.md", "LICENSE", "package.json"]) assert.ok(paths.includes(expected), expected);
  assert.equal(paths.some((p) => p.startsWith("extension/") || p.startsWith("test/") || p.startsWith("docs/")), false);
});
```

The last test runs npm. Under `npm test`, `npm_execpath` is set, so it runs `node <npm_execpath> pack …`; when run directly with `node --test`, it runs `npm` from PATH.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — `host/src/cli.js` does not exist; the package is still `claude-in-firefox`.

- [ ] **Step 3: Implement**

Create `host/src/cli.js`:

```js
#!/usr/bin/env node
import { install, uninstall } from "./install.js";
import { runMcpServer } from "./mcp-server.js";
import { PACKAGE_VERSION, isMain } from "./paths.js";

export const USAGE = `Usage: claude-firefox <command>

Commands:
  install [--no-claude]    Install the bridge for Firefox and register it with Claude Code
  uninstall [--no-claude]  Remove everything install created
  mcp                      Run the MCP server on stdio (MCP clients start this)

Options:
  --version                Print the version
  --help                   Print this help`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" && rest.length === 0) return { command: "help" };
  if (command === "--version" && rest.length === 0) return { command: "version" };
  if (command === "mcp" && rest.length === 0) return { command };
  if ((command === "install" || command === "uninstall") && rest.every((arg) => arg === "--no-claude")) return { command, claude: !rest.includes("--no-claude") };
  return { command: "usage-error" };
}

export function formatInstall({ appDir, manifestPath, claudeStatus, claudeCommand, mcpConfig }) {
  const claude = {
    registered: 'Claude Code: registered the "firefox" MCP server.',
    "not-found": `Claude Code: \`claude\` was not found on PATH. Register the server with:\n  ${claudeCommand}`,
    skipped: `Claude Code: skipped (--no-claude). Register the server with:\n  ${claudeCommand}`,
  }[claudeStatus];
  return [
    `Installed Claude Code Bridge for Firefox ${PACKAGE_VERSION}`,
    `  App directory:     ${appDir}`,
    `  Native messaging:  ${manifestPath}`,
    "",
    claude,
    "",
    "Other MCP clients (Claude Desktop and others): add this to their MCP configuration:",
    JSON.stringify(mcpConfig, null, 2),
    "",
    "Install the Firefox add-on from https://github.com/llyfn/claude-in-firefox/releases/latest if you have not yet.",
  ].join("\n");
}

export function formatUninstall({ removed }) {
  if (!removed.length) return "Nothing to remove: Claude Code Bridge for Firefox is not installed.";
  return ["Removed:", ...removed.map((item) => `  ${item}`)].join("\n");
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "help") console.log(USAGE);
  else if (args.command === "version") console.log(PACKAGE_VERSION);
  else if (args.command === "mcp") await runMcpServer();
  else if (args.command === "install") console.log(formatInstall(await install({ claude: args.claude })));
  else if (args.command === "uninstall") console.log(formatUninstall(await uninstall({ claude: args.claude })));
  else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(`claude-firefox: ${err.message}`);
    process.exitCode = 1;
  }
}
```

Make it executable: `chmod +x host/src/cli.js` (git records the mode).

Change `package.json` to (keep `scripts.test`, `lint`, `build`, `e2e`, `dependencies`, `devDependencies` as they are):

```json
{
  "name": "@llyfn/claude-in-firefox",
  "version": "0.2.0",
  "description": "Drive Firefox from Claude Code and other MCP clients",
  "license": "MIT",
  "type": "module",
  "repository": { "type": "git", "url": "git+https://github.com/llyfn/claude-in-firefox.git" },
  "homepage": "https://github.com/llyfn/claude-in-firefox#readme",
  "bin": { "claude-firefox": "host/src/cli.js" },
  "files": ["host/src", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/unit/*.test.js",
    "lint": "web-ext lint --source-dir extension",
    "build": "web-ext build --source-dir extension --overwrite-dest",
    "install-host": "node host/src/cli.js install",
    "e2e": "node --test --test-concurrency=1 test/e2e/*.test.js"
  }
}
```

(merged with the existing `dependencies` and `devDependencies`), then run `npm install --package-lock-only` so `package-lock.json` carries the new name.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test && npm run lint`
Expected: PASS.

Then smoke-test the real flow on this machine without touching Claude Code: `npm run install-host -- --no-claude`. Expected: it packs the clone, installs into `~/Library/Application Support/claude-in-firefox/node_modules/@llyfn/claude-in-firefox`, rewrites the native manifest to the new wrapper, removes the old `host/` folder, and prints the summary. (This writes outside the repository into the same locations the previous installer used; the controller has approved it for this plan.) Then `"$HOME/Library/Application Support/claude-in-firefox/node_modules/.bin/claude-firefox" --version` prints the version.

- [ ] **Step 5: Commit**

```bash
git add host/src/cli.js package.json package-lock.json test/unit/cli.test.js
git commit -m "Add the claude-firefox CLI and publish as @llyfn/claude-in-firefox"
```

---

### Task 4: Unit tests on Windows, and CI

**Files:**
- Create: `.github/workflows/ci.yml` (unit job only in this task)
- Modify: unit tests and, only if Windows exposes a real bug, production code under `host/src`
- Test: the whole unit suite on ubuntu-latest, macos-latest and windows-latest

**Interfaces:** none new.

- [ ] **Step 1: Add the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  unit:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test
      - if: matrix.os == 'ubuntu-latest'
        run: npm run lint
```

- [ ] **Step 2: Run it on GitHub**

Commit the workflow, push the branch (`git push -u origin feat/distribution`), and trigger the workflow on the branch (`gh workflow run CI --ref feat/distribution` does not work for `pull_request`/`push` triggers on non-main branches, so add `workflow_dispatch:` to `on:` and use `gh workflow run ci.yml --ref feat/distribution`; keep `workflow_dispatch` in the final file). Watch with `gh run watch` and read failures with `gh run view <id> --log-failed`.

- [ ] **Step 3: Make the suite pass on Windows**

Expected Windows failures and the fix for each kind:
- Tests that use Unix sockets under `/tmp` (`native-host.test.js`, `mcp-server.test.js`): give them an address helper that returns `\\.\pipe\cfb-test-<random hex>` on Windows and the existing `/tmp/...sock` path elsewhere, and run them with `platform` left at its default. Tests that exist only to exercise Unix directory checks (`paths.test.js` `verifySocketDir` tests, the "Windows transport skips directory checks" tests, which use `chmod`) get `{ skip: process.platform === "win32" && "Unix sockets and file modes" }`.
- Tests that create executables with shebangs and modes (`install.test.js` `binDir`, `stableNodePath`): on Windows, executability is by extension; adjust helpers so the Linux-simulating tests still assert what they mean, or skip with a reason when the assertion is Unix-only (mode `0o755`). The simulated-`win32` tests must still pass on Windows.
- `path.join` expectations: assertions must build expected paths with `path.join` (already the case); fix any literal `/` separators the Windows run exposes.
- `runCommand` on Windows: add a test (Windows only) that runs a `.cmd` file whose path contains a space with an argument containing a space, and checks the argument arrives intact.
- `cli.test.js` `npm pack` test: must work under `npm test` on Windows (it uses `npm_execpath`).
A failure that reveals a real production bug (not a test assumption) gets a production fix plus a test that pins it. Record each kind of change in the report.

- [ ] **Step 4: Verify**

Run locally: `npm test && npm run lint`. CI: the `unit` job is green on all three OSes (paste the run URL into the report).

- [ ] **Step 5: Commit**

Commit the workflow and test changes in coherent commits, e.g. `git commit -m "Run unit tests on Linux, macOS and Windows in CI"` and `git commit -m "Make the unit tests portable to Windows"`.

---

### Task 5: End-to-end on Linux and Windows CI

**Files:**
- Modify: `test/e2e/harness.js`
- Modify: `.github/workflows/ci.yml` (add the `e2e` job)
- Modify: production code only if a real bug shows up (with a unit test)

**Interfaces:**
- Consumes: `bridgeAddress`, `nativeManifestPath` (Task 1), the CLI (Task 3).

- [ ] **Step 1: Make the harness portable**

In `test/e2e/harness.js`:
- import `bridgeAddress` and `nativeManifestPath` from `paths.js` (drop `SOCKET_PATH`); compute `const address = bridgeAddress();` inside `startHarness` (it throws with the install hint when the Windows pipe name is missing) and use it in the liveness probe and the "already served" message;
- default Firefox per platform:

```js
const DEFAULT_FIREFOX = {
  darwin: "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
  win32: "C:\\Program Files\\Firefox Developer Edition\\firefox.exe",
};
const FIREFOX = process.env.FIREFOX_BIN ?? DEFAULT_FIREFOX[process.platform];
```

and fail with `Set FIREFOX_BIN to your Firefox Developer Edition binary.` when it is undefined;
- spawn web-ext as `process.execPath` with `path.join(ROOT, "node_modules/web-ext/bin/web-ext.js")` as the first argument (no `.cmd` shim on Windows);
- start the MCP server as `process.execPath` with `[path.join(ROOT, "host/src/cli.js"), "mcp"]`;
- on Windows, `kill("SIGINT")` is not a signal; keep the existing kill sequence but make sure teardown ends Firefox (e.g. `kill()` then a bounded wait), and that the bridge pipe is free for the next run.

Run locally on macOS: `npm run install-host -- --no-claude` then `npm run e2e`. Expected: all pass (45 tests as of 0.2.0).

- [ ] **Step 2: Add the e2e job**

Append to `.github/workflows/ci.yml` under `jobs:`:

```yaml
  e2e:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - name: Install Firefox Developer Edition (Linux)
        if: runner.os == 'Linux'
        run: |
          curl -fsSL -o "$RUNNER_TEMP/firefox.tar.xz" "https://download.mozilla.org/?product=firefox-devedition-latest-ssl&os=linux64&lang=en-US"
          tar -xJf "$RUNNER_TEMP/firefox.tar.xz" -C "$RUNNER_TEMP"
          echo "FIREFOX_BIN=$RUNNER_TEMP/firefox/firefox" >> "$GITHUB_ENV"
      - name: Install Firefox Developer Edition (Windows)
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          Invoke-WebRequest "https://download.mozilla.org/?product=firefox-devedition-latest-ssl&os=win64&lang=en-US" -OutFile "$env:RUNNER_TEMP\firefox.exe"
          Start-Process -FilePath "$env:RUNNER_TEMP\firefox.exe" -ArgumentList "/S" -Wait
          "FIREFOX_BIN=C:\Program Files\Firefox Developer Edition\firefox.exe" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
      - run: npm run install-host -- --no-claude
      - name: End-to-end tests (Linux)
        if: runner.os == 'Linux'
        run: xvfb-run -a npm run e2e
      - name: End-to-end tests (Windows)
        if: runner.os == 'Windows'
        run: npm run e2e
```

The tarball's format or the installer's target directory may differ from these assumptions (the spec lists them under "Verify during implementation"); adjust the step to what you observe and record it.

- [ ] **Step 3: Iterate on CI until green**

Push, run (`gh workflow run ci.yml --ref feat/distribution`), and fix with `gh run view <id> --log-failed`. Investigate each failure systematically; Windows-specific production bugs (the `.cmd` wrapper's stdio, the pipe, path quoting in the manifest) get a fix plus a unit test. Do not weaken or skip an e2e test to get green; if one cannot pass on a platform for a reason outside this project's control, stop and report it with evidence.

- [ ] **Step 4: Verify**

Locally: `npm test && npm run lint && npm run e2e`. CI: `unit` (3 OSes) and `e2e` (Linux, Windows) green; paste the run URL.

- [ ] **Step 5: Commit**

Coherent commits, e.g. `git commit -m "Run the end-to-end tests on Linux and Windows in CI"`.

---

### Task 6: Release to npm, README and version 0.3.0

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `extension/manifest.json`, `package.json`, `package-lock.json` (version)

- [ ] **Step 1: Release workflow**

In `.github/workflows/release.yml`:
- give `actions/setup-node@v4` `registry-url: https://registry.npmjs.org`;
- replace the version check step's script with:

```bash
          manifest=$(node -p 'require("./extension/manifest.json").version')
          package=$(node -p 'require("./package.json").version')
          if [ "v$manifest" != "$GITHUB_REF_NAME" ] || [ "v$package" != "$GITHUB_REF_NAME" ]; then
            echo "Tag $GITHUB_REF_NAME must match extension/manifest.json ($manifest) and package.json ($package)"
            exit 1
          fi
```

- after the AMO signing step and before the GitHub release step add:

```yaml
      - name: Publish to npm
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: npm publish --access public
```

- [ ] **Step 2: Version 0.3.0**

`npm version 0.3.0 --no-git-tag-version`; set `"version": "0.3.0"` in `extension/manifest.json`. (`PACKAGE_VERSION` drives the CLI and the MCP server version.)

- [ ] **Step 3: README**

Rewrite these README sections (keep the title, the non-affiliation notice, Tools, Safety and Limitations as they are, except where noted):

- **How it works:** replace the paragraph about where the MCP server and native host run with: `Both halves run from one copy of the package that the installer puts in an app directory (~/Library/Application Support/claude-in-firefox on macOS, ~/.local/share/claude-in-firefox on Linux, %LOCALAPPDATA%\claude-in-firefox on Windows). Firefox starts the native host from there through native messaging, and MCP clients start the MCP server from there. On Windows the two meet on a named pipe whose random name is kept in pipe-name in that directory, because Node cannot restrict a pipe to one user.`
- **Requirements:** `macOS, Linux or Windows, with Node ≥ 20 on PATH.` `Firefox 140 or newer. The signed add-on works in regular Firefox; unsigned development builds need Firefox Developer Edition or Nightly.` `On Linux, use a Firefox installed from Mozilla or your distribution's package; the Snap and Flatpak builds keep native-messaging hosts elsewhere and are not supported.` `Node ≥ 22.22 for development and tests.`
- **Install:**
  1. Download the `.xpi` from the latest release and open it in Firefox.
  2. Run `npx @llyfn/claude-in-firefox install`. It installs the bridge, registers the native host with Firefox (a registry key on Windows), and registers the `firefox` MCP server with Claude Code when the `claude` command is available. Pass `--no-claude` to skip that.
  3. Start a new Claude Code session and ask it to use the `firefox` tools; it should begin with `tabs_context` and `createIfEmpty: true`.
- **Update:** `npx @llyfn/claude-in-firefox@latest install`, and install the `.xpi` from the newer release (the add-on does not update itself).
- **Uninstall:** `npx @llyfn/claude-in-firefox uninstall` removes the Claude Code entry, the native-messaging registration and the app directory. Remove the add-on in `about:addons`.
- **Other MCP clients:** the installer prints a JSON block; add it to the client's MCP configuration. For Claude Desktop that file is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Show the block's shape: `{ "mcpServers": { "firefox": { "command": "<path to node>", "args": ["<app directory>/node_modules/@llyfn/claude-in-firefox/host/src/cli.js", "mcp"] } } }`. Each client process is its own session with its own window.
- **Development:** clone, `npm install`, `npm run install-host` (packs the clone and installs it like a release; pass `-- --no-claude` to leave Claude Code alone). Keep the existing unsigned-build and e2e notes; e2e uses `FIREFOX_BIN` if set, otherwise the default Developer Edition path on macOS and Windows; on Linux set `FIREFOX_BIN`. CI runs unit tests on Linux, macOS and Windows and e2e on Linux and Windows.
- **Releasing:** one-time setup adds `gh secret set NPM_TOKEN` (an npm automation token for the `@llyfn` scope) next to the AMO secrets; each release bumps `version` in both `extension/manifest.json` and `package.json`; the workflow checks both, runs tests and lint, signs the add-on, publishes `@llyfn/claude-in-firefox` to npm, and creates the GitHub release.
- **Troubleshooting:** update the not-connected item to say: Firefox isn't running, the add-on isn't installed, or `npx @llyfn/claude-in-firefox install` wasn't run; on Windows, `pipe-name` in the app directory must exist. Update the Node-upgrade item to say: re-run `npx @llyfn/claude-in-firefox install`, which rewrites the wrapper and the Claude Code entry with the current node.
- **Limitations:** add `Windows support is tested in CI with Firefox Developer Edition; report problems with other setups.`

- [ ] **Step 4: Verify**

Run: `npm test && npm run lint && npm run e2e`; also `npm pack --dry-run` lists only `host/src`, `README.md`, `LICENSE`, `package.json`. Push and confirm CI is green.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml README.md extension/manifest.json package.json package-lock.json
git commit -m "Publish to npm on release, document the npx install, and release 0.3.0"
```
