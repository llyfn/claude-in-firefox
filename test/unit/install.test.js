import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable, install, runCommand, stableNodePath, uninstall } from "../../host/src/install.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const ADDON_ID = JSON.parse(fs.readFileSync(path.join(REPO, "extension/manifest.json"), "utf8")).browser_specific_settings.gecko.id;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cfb-install-"));
const PIPE = /^\\\\\.\\pipe\\claude-firefox-bridge-[0-9a-f]{32}\n$/;
const KEY = /^[0-9a-f]{64}\n$/;

function fakeRun({ failing = [], skipPackage = false } = {}) {
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command: path.basename(command), args, cwd: options.cwd });
    if (failing.some((f) => [command, ...args].join(" ").includes(f))) throw new Error(`${command} failed`);
    if (args.includes("install") && !skipPackage) {
      const host = path.join(args[args.indexOf("--prefix") + 1], "node_modules/@llyfn/claude-in-firefox/host/src");
      fs.mkdirSync(host, { recursive: true });
      fs.writeFileSync(path.join(host, "native-host.js"), "");
    }
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

// Unix refuses to remove entries of a read-only directory; Windows refuses to remove a directory that is a process's working directory.
// A Windows child opens its working directory during its own startup, after "spawn", so the lock holds only once it has printed.
async function blockRemoval(dir) {
  if (process.platform !== "win32") {
    fs.chmodSync(path.dirname(dir), 0o555);
    return async () => fs.chmodSync(path.dirname(dir), 0o755);
  }
  const holder = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { cwd: dir });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The lock holder did not start within 10 s")), 10_000);
      holder.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      holder.once("error", (err) => { clearTimeout(timer); reject(err); });
      holder.once("exit", (code) => { clearTimeout(timer); reject(new Error(`The lock holder exited with ${code} before it started`)); });
    });
  } catch (err) {
    holder.kill();
    throw err;
  }
  return async () => {
    holder.kill();
    await once(holder, "exit");
  };
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
  assert.equal(fs.readFileSync(result.wrapperPath, "utf8"), `#!/bin/sh\nexec '/opt/node/bin/node' '${path.join(pkgDir, "host/src/native-host.js")}' "$@"\n`);
  assert.equal(result.manifestPath, path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")), {
    name: "claude_firefox_bridge",
    description: "Claude Code Bridge for Firefox",
    path: result.wrapperPath,
    type: "stdio",
    allowed_extensions: [ADDON_ID],
  });
  assert.deepEqual(result.mcpConfig, { mcpServers: { firefox: { command: "/opt/node/bin/node", args: [cli, "mcp"] } } });
  assert.equal(result.claudeCommand, `claude mcp add --scope user firefox -- '/opt/node/bin/node' '${cli}' mcp`);
});

test("the macOS and Linux wrapper is executable", { skip: process.platform === "win32" && "Windows has no Unix file modes" }, async () => {
  const result = await install({ homeDir: tmp(), platform: "linux", env: { PATH: "", npm_execpath: "/n/npm-cli.js" }, nodePath: "/usr/bin/node", packageRoot: REPO, run: fakeRun().run, claude: false });
  assert.equal(fs.statSync(result.wrapperPath).mode & 0o777, 0o755);
});

test("the macOS and Linux wrapper and the printed claude command quote paths for the shell", { skip: process.platform === "win32" && "runs the wrapper with /bin/sh" }, async () => {
  const root = tmp();
  const nodeDir = path.join(root, "it's $(touch pwned) `touch pwned2` 100%");
  fs.mkdirSync(nodeDir);
  const nodePath = path.join(nodeDir, "node");
  fs.writeFileSync(nodePath, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
  const home = path.join(root, "o'brien home");
  const result = await install({ homeDir: home, platform: "linux", env: { PATH: "", npm_execpath: "/n/npm-cli.js" }, nodePath, packageRoot: REPO, run: fakeRun().run, claude: false });

  const quotedNode = `'${root}/it'\\''s $(touch pwned) \`touch pwned2\` 100%/node'`;
  const quotedPkg = `'${root}/o'\\''brien home/.local/share/claude-in-firefox/node_modules/@llyfn/claude-in-firefox`;
  assert.equal(fs.readFileSync(result.wrapperPath, "utf8"), `#!/bin/sh\nexec ${quotedNode} ${quotedPkg}/host/src/native-host.js' "$@"\n`);
  assert.equal(result.claudeCommand, `claude mcp add --scope user firefox -- ${quotedNode} ${quotedPkg}/host/src/cli.js' mcp`);

  const cwd = tmp();
  const { stdout } = spawnSync(result.wrapperPath, ["--from-firefox"], { cwd, encoding: "utf8" });
  assert.equal(stdout, `${path.join(home, ".local/share/claude-in-firefox/node_modules/@llyfn/claude-in-firefox/host/src/native-host.js")}\n--from-firefox\n`);
  assert.deepEqual(fs.readdirSync(cwd), []);
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

test("an npm_execpath that is not npm's falls back to npm on PATH", async () => {
  const { run, calls } = fakeRun();
  await install({ homeDir: tmp(), platform: "linux", env: { PATH: binDir("npm"), npm_execpath: "/x/pnpm.cjs" }, nodePath: "/usr/bin/node", packageRoot: REPO, run, claude: false });
  assert.deepEqual([calls[0].command, calls[0].args[0]], ["npm", "pack"]);
});

test("a clone under some node_modules folder is packed, not fetched from the registry", async () => {
  const root = path.join(tmp(), "node_modules/foo/clone");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  const { run, calls } = fakeRun();
  await install({ homeDir: tmp(), platform: "linux", env: { PATH: "", npm_execpath: "/n/npm-cli.js" }, nodePath: "/usr/bin/node", packageRoot: root, run, claude: false });
  assert.equal(calls[0].args[1], "pack");
});

test("install fails when npm did not produce the package, and a failing npm install leaves the previous install alone", async () => {
  const home = tmp();
  const env = { PATH: "", npm_execpath: "/n/npm-cli.js" };
  const options = { homeDir: home, platform: "linux", env, nodePath: "/usr/bin/node", packageRoot: REPO, claude: false };
  await assert.rejects(install({ ...options, run: fakeRun({ skipPackage: true }).run }), /npm installed .* but .*claude-in-firefox is missing/);
  const legacy = path.join(home, ".local/share/claude-in-firefox/host");
  const manifest = path.join(home, ".mozilla/native-messaging-hosts/claude_firefox_bridge.json");
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, "old");
  await assert.rejects(install({ ...options, run: fakeRun({ failing: ["install"] }).run }), /failed/);
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.readFileSync(manifest, "utf8"), "old");
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
  assert.match(b.claudeCommand, /^claude mcp add --scope user firefox -- '\/usr\/bin\/node' '.*cli\.js' mcp$/);
});

test("a failing claude mcp remove is ignored and a failing add is reported without aborting the install", async () => {
  const env = { PATH: binDir("claude"), npm_execpath: "/npm/bin/npm-cli.js" };
  const ok = await install({ homeDir: tmp(), platform: "linux", env, nodePath: "/usr/bin/node", packageRoot: REPO, run: fakeRun({ failing: ["mcp remove"] }).run });
  assert.equal(ok.claudeStatus, "registered");
  const bad = await install({ homeDir: tmp(), platform: "linux", env, nodePath: "/usr/bin/node", packageRoot: REPO, run: fakeRun({ failing: ["mcp add"] }).run });
  assert.equal(bad.claudeStatus, "failed");
  assert.match(bad.claudeError, /failed/);
  assert.equal(fs.existsSync(bad.manifestPath), true);
  assert.match(bad.claudeCommand, /^claude mcp add --scope user firefox -- '\/usr\/bin\/node' '.*cli\.js' mcp$/);
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
  assert.equal(fs.readFileSync(result.wrapperPath, "utf8"), `@echo off\r\n"C:\\node\\node.exe" "%~dp0node_modules\\@llyfn\\claude-in-firefox\\host\\src\\native-host.js" %*\r\n`);
  assert.equal(result.claudeCommand, `claude mcp add --scope user firefox -- "C:\\node\\node.exe" "${path.join(appDir, "node_modules/@llyfn/claude-in-firefox/host/src/cli.js")}" mcp`);
  assert.match(fs.readFileSync(path.join(appDir, "pipe-name"), "utf8"), PIPE);
  assert.equal(result.manifestPath, path.join(appDir, "claude_firefox_bridge.json"));
  assert.deepEqual([calls.at(-1).command, ...calls.at(-1).args], ["reg", "add", "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\claude_firefox_bridge", "/ve", "/t", "REG_SZ", "/d", result.manifestPath, "/f"]);
});

test("on Windows the node path is double-quoted with percent signs doubled, and a non-ASCII one is warned about", async () => {
  const env = { PATH: "", LOCALAPPDATA: tmp(), npm_execpath: "C:/npm/npm-cli.js" };
  const options = { homeDir: tmp(), platform: "win32", env, packageRoot: REPO, run: fakeRun().run, claude: false };
  const plain = await install({ ...options, nodePath: "C:\\it's $(touch x) `y` 100%\\node.exe" });
  assert.equal(fs.readFileSync(plain.wrapperPath, "utf8"), `@echo off\r\n"C:\\it's $(touch x) \`y\` 100%%\\node.exe" "%~dp0node_modules\\@llyfn\\claude-in-firefox\\host\\src\\native-host.js" %*\r\n`);
  assert.deepEqual(plain.warnings, []);
  const odd = await install({ ...options, nodePath: "C:\\Users\\\u00e9\\node.exe" });
  assert.deepEqual(odd.warnings, ["Node is installed at a path with non-ASCII characters (C:\\Users\\\u00e9\\node.exe); Firefox may fail to start the native host. Install Node in a path with only ASCII characters if the add-on cannot connect."]);
});

test("the Windows pipe name and key are created once and kept", async () => {
  const local = tmp();
  const env = { PATH: "", LOCALAPPDATA: local, npm_execpath: "C:/npm/npm-cli.js" };
  const options = { homeDir: tmp(), platform: "win32", env, nodePath: "node.exe", packageRoot: REPO, claude: false };
  const read = (name) => fs.readFileSync(path.join(local, "claude-in-firefox", name), "utf8");
  await install({ ...options, run: fakeRun().run });
  const name = read("pipe-name");
  const key = read("pipe-key");
  assert.match(key, KEY);
  await install({ ...options, run: fakeRun().run });
  assert.equal(read("pipe-name"), name);
  assert.equal(read("pipe-key"), key);
});

test("install replaces a malformed Windows pipe name or key", async () => {
  const local = tmp();
  const env = { PATH: "", LOCALAPPDATA: local, npm_execpath: "C:/npm/npm-cli.js" };
  const options = { homeDir: tmp(), platform: "win32", env, nodePath: "node.exe", packageRoot: REPO, claude: false };
  const file = (name) => path.join(local, "claude-in-firefox", name);
  fs.mkdirSync(path.join(local, "claude-in-firefox"));
  fs.writeFileSync(file("pipe-name"), "\\\\.\\pipe\\something-else\n");
  fs.writeFileSync(file("pipe-key"), "not a key\n");
  await install({ ...options, run: fakeRun().run });
  assert.match(fs.readFileSync(file("pipe-name"), "utf8"), PIPE);
  assert.match(fs.readFileSync(file("pipe-key"), "utf8"), KEY);
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

test("uninstall fails before touching Claude Code on an unsupported platform, and reports what it could not remove", async () => {
  const { run, calls } = fakeRun();
  await assert.rejects(uninstall({ homeDir: tmp(), platform: "aix", env: { PATH: binDir("claude") }, run }), /Unsupported platform/);
  assert.equal(calls.length, 0);
  const clean = await uninstall({ homeDir: tmp(), platform: "linux", env: { PATH: "" }, run });
  assert.deepEqual(clean.failed, []);

  const home = tmp();
  const appDir = path.join(home, ".local/share/claude-in-firefox");
  fs.mkdirSync(path.join(appDir, "sub"), { recursive: true });
  const unblock = await blockRemoval(appDir);
  try {
    const result = await uninstall({ homeDir: home, platform: "linux", env: { PATH: "" }, run });
    assert.deepEqual(result.removed, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].path, appDir);
    assert.equal(typeof result.failed[0].error, "string");
  } finally {
    await unblock();
  }
});

test("findExecutable checks PATH, with PATHEXT on Windows", () => {
  const unix = binDir("claude");
  assert.equal(findExecutable("claude", { PATH: `"${unix}"` }, "linux"), path.join(unix, "claude"));
  assert.equal(findExecutable("claude", { PATH: ["relative", unix].join(path.delimiter) }, "linux"), path.join(unix, "claude"));
  assert.equal(findExecutable("claude", { PATH: "" }, "linux"), null);
  const win = binDir("claude.cmd");
  assert.equal(findExecutable("claude", { PATH: win, PATHEXT: ".EXE;.CMD" }, "win32"), path.join(win, "claude.cmd"));
});

test("node and claude in a node_modules folder on PATH are passed over for the ones after it", () => {
  const root = tmp();
  const planted = [path.join(root, "proj/node_modules/.bin"), path.join(root, "_npx/1a2b/node_modules/.bin")];
  for (const dir of planted) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["node", "claude", "node.exe", "claude.cmd"]) fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  const real = binDir("node", "claude", "node.exe", "claude.cmd");
  const PATH = [...planted, real].join(path.delimiter);
  assert.equal(stableNodePath({ PATH }, "linux"), path.join(real, "node"));
  assert.equal(findExecutable("claude", { PATH }, "linux"), path.join(real, "claude"));
  assert.equal(stableNodePath({ PATH }, "win32"), path.join(real, "node.exe"));
  assert.equal(findExecutable("claude", { PATH, PATHEXT: ".EXE;.CMD" }, "win32"), path.join(real, "claude.cmd"));
});

test("stableNodePath returns the first executable node on PATH without resolving symlinks", { skip: process.platform === "win32" && "Windows has no execute permission bit" }, () => {
  const root = tmp();
  const real = path.join(root, "Cellar/node/1.0/bin");
  const stable = path.join(root, "bin");
  const noExec = path.join(root, "noexec");
  for (const dir of [real, stable, noExec]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(real, "node"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(path.join(real, "node"), path.join(stable, "node"));
  fs.writeFileSync(path.join(noExec, "node"), "", { mode: 0o644 });
  assert.equal(stableNodePath({ PATH: ["relative", path.join(root, "missing"), noExec, stable, real].join(path.delimiter) }, "linux"), path.join(stable, "node"));
});

test("stableNodePath finds node.exe on Windows and falls back to the running node", () => {
  assert.equal(stableNodePath({ PATH: path.join(tmp(), "missing") }, "linux"), process.execPath);
  const win = binDir("node.exe");
  assert.equal(stableNodePath({ PATH: win }, "win32"), path.join(win, "node.exe"));
});

test("runCommand resolves with output and rejects with the command's error text", async () => {
  assert.equal((await runCommand(process.execPath, ["-e", "console.log('hi')"])).stdout, "hi\n");
  await assert.rejects(runCommand(process.execPath, ["-e", "console.error('nope'); process.exit(3)"]), /failed: nope/);
});

test("runCommand passes arguments with spaces intact to a .cmd file whose path has a space", { skip: process.platform !== "win32" && "only Windows runs .cmd files through cmd.exe" }, async () => {
  const dir = path.join(tmp(), "with space");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "print-args.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const cmd = path.join(dir, "print args.cmd");
  fs.writeFileSync(cmd, `@"${process.execPath}" "%~dp0print-args.js" %*\r\n`);
  const args = ["mcp", "C:\\Users\\Jane Doe\\cli.js"];
  assert.deepEqual(JSON.parse((await runCommand(cmd, args)).stdout), args);
});

test("unsupported platforms are refused before anything is written", async () => {
  const home = tmp();
  await assert.rejects(install({ homeDir: home, platform: "aix", env: { PATH: "" }, nodePath: "node", packageRoot: REPO, run: fakeRun().run }), /Unsupported platform "aix"/);
  assert.deepEqual(fs.readdirSync(home), []);
});
