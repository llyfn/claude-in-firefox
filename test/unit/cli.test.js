import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  const base = { appDir: "/app", manifestPath: "/m.json", warnings: [], claudeCommand: 'claude mcp add --scope user firefox -- "/node" "/app/cli.js" mcp', mcpConfig: { mcpServers: { firefox: { command: "/node", args: ["/app/cli.js", "mcp"] } } } };
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

test("the install summary reports a failed Claude Code registration with the command to run", () => {
  const out = formatInstall({ appDir: "/app", manifestPath: "/m.json", warnings: [], claudeStatus: "failed", claudeError: "exit 1", claudeCommand: "claude mcp add x", mcpConfig: {} });
  assert.match(out, /Claude Code: registering the "firefox" MCP server failed \(exit 1\)\. Register it with:\n {2}claude mcp add x/);
});

test("the install summary prints warnings right after the native messaging line", () => {
  const out = formatInstall({ appDir: "/app", manifestPath: "/m.json", warnings: ["one", "two"], claudeStatus: "registered", claudeCommand: "c", mcpConfig: {} });
  assert.match(out, /Native messaging: {2}\/m\.json\nWarning: one\nWarning: two\n\nClaude Code:/);
});

test("the uninstall summary lists what was removed", () => {
  assert.equal(formatUninstall({ removed: ["a", "b"], failed: [] }), "Removed:\n  a\n  b");
  assert.equal(formatUninstall({ removed: [], failed: [] }), "Nothing to remove: Claude Code Bridge for Firefox is not installed.");
});

test("the uninstall summary lists what could not be removed", () => {
  const failed = [{ path: "/x", error: "EBUSY" }];
  assert.equal(formatUninstall({ removed: ["a"], failed }), "Removed:\n  a\nCould not remove:\n  /x: EBUSY\nClose Firefox and run uninstall again.");
  assert.equal(formatUninstall({ removed: [], failed }), "Could not remove:\n  /x: EBUSY\nClose Firefox and run uninstall again.");
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
