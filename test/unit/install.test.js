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
