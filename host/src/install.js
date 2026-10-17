import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, HOST_NAME, PACKAGE_NAME, PIPE_KEY_FILE, PIPE_NAME_FILE, REGISTRY_KEY, appDirFor, bridgeAddress, bridgeKey, nativeManifestPath, packageDirFor } from "./paths.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MCP_NAME = "firefox";

const succeeds = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

const quoteForCmd = (arg) => (/^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${String(arg).replace(/"/g, '""')}"`);

export function runCommand(command, args, { cwd } = {}) {
  // Windows runs .cmd and .bat files only through the shell, which needs the arguments quoted for cmd.exe.
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const options = { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    const done = (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(command)} ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    };
    if (viaShell) execFile([command, ...args].map(quoteForCmd).join(" "), { ...options, shell: true }, done);
    else execFile(command, args, options, done);
  });
}

export function findExecutable(name, env = process.env, platform = process.platform) {
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((ext) => ext.toLowerCase()) : [""];
  for (const entry of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
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
  // pnpm and yarn set npm_execpath to their own CLI.
  if (/^np[mx]-cli\.js$/.test(path.basename(env.npm_execpath ?? ""))) {
    const cli = path.basename(env.npm_execpath) === "npx-cli.js" ? path.join(path.dirname(env.npm_execpath), "npm-cli.js") : env.npm_execpath;
    return run(process.execPath, [cli, ...args], options);
  }
  const npmPath = findExecutable("npm", env, platform);
  if (!npmPath) throw new Error("npm was not found on PATH");
  return run(npmPath, args, options);
}

function verifyInstalled(pkgDir, source) {
  if (!fs.existsSync(path.join(pkgDir, "host", "src", "native-host.js"))) throw new Error(`npm installed ${source} but ${pkgDir} is missing`);
}

function isInstalledPackage(root) {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts.at(-2) === "@llyfn" && parts.at(-3) === "node_modules";
}

async function installPackage({ appDir, pkgDir, packageRoot, run, env, platform }) {
  const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (isInstalledPackage(packageRoot)) {
    const source = `${PACKAGE_NAME}@${version}`;
    await npm(run, env, platform, ["install", "--prefix", appDir, "--omit=dev", "--no-audit", "--no-fund", source]);
    verifyInstalled(pkgDir, source);
    return;
  }
  // A folder install would symlink the clone; a packed tarball installs exactly what users get.
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-firefox-pack-"));
  try {
    const { stdout } = await npm(run, env, platform, ["pack", "--pack-destination", packDir, "--silent"], { cwd: packageRoot });
    const tarball = path.join(packDir, stdout.trim().split(/\r?\n/).pop());
    await npm(run, env, platform, ["install", "--prefix", appDir, "--omit=dev", "--no-audit", "--no-fund", tarball]);
    verifyInstalled(pkgDir, tarball);
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
  await installPackage({ appDir, pkgDir, packageRoot, run, env, platform });

  let wrapperPath;
  const warnings = [];
  if (platform === "win32") {
    wrapperPath = path.join(appDir, "native-host.cmd");
    // The wrapper's bytes are decoded with the OEM code page, so it names the host script relative to itself instead of embedding profile paths.
    fs.writeFileSync(wrapperPath, `@echo off\r\n"${nodePath.replace(/%/g, "%%")}" "%~dp0node_modules\\@llyfn\\claude-in-firefox\\host\\src\\native-host.js" %*\r\n`);
    if (/[^\x00-\x7f]/.test(nodePath)) warnings.push(`Node is installed at a path with non-ASCII characters (${nodePath}); Firefox may fail to start the native host. Install Node in a path with only ASCII characters if the add-on cannot connect.`);
    if (!succeeds(() => bridgeAddress({ platform, appDir }))) fs.writeFileSync(path.join(appDir, PIPE_NAME_FILE), `\\\\.\\pipe\\claude-firefox-bridge-${randomBytes(16).toString("hex")}\n`);
    if (!succeeds(() => bridgeKey({ platform, appDir }))) fs.writeFileSync(path.join(appDir, PIPE_KEY_FILE), `${randomBytes(32).toString("hex")}\n`);
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
  let claudeError;
  let claudeStatus = claude ? "not-found" : "skipped";
  if (claudePath) {
    await run(claudePath, ["mcp", "remove", "--scope", "user", MCP_NAME]).catch(() => {});
    try {
      await run(claudePath, ["mcp", "add", "--scope", "user", MCP_NAME, "--", ...mcpArgs]);
      claudeStatus = "registered";
    } catch (err) {
      claudeStatus = "failed";
      claudeError = err.message;
    }
  }

  return { appDir, pkgDir, manifestPath, wrapperPath, claudeStatus, claudeError, claudeCommand, warnings, mcpConfig: { mcpServers: { [MCP_NAME]: { command: nodePath, args: [cliScript, "mcp"] } } } };
}

export async function uninstall({ homeDir = os.homedir(), platform = process.platform, env = process.env, run = runCommand, claude = true } = {}) {
  const manifestPath = nativeManifestPath(homeDir, platform, env);
  const appDir = appDirFor(homeDir, platform, env);
  const removed = [];
  const failed = [];
  const claudePath = claude ? findExecutable("claude", env, platform) : null;
  if (claudePath && (await run(claudePath, ["mcp", "remove", "--scope", "user", MCP_NAME]).then(() => true, () => false))) removed.push(`Claude Code MCP server "${MCP_NAME}"`);
  if (platform === "win32" && (await run("reg", ["delete", REGISTRY_KEY, "/f"]).then(() => true, () => false))) removed.push(`registry key ${REGISTRY_KEY}`);
  const remove = (target, options) => {
    if (!fs.existsSync(target)) return;
    try {
      fs.rmSync(target, { force: true, ...options });
      removed.push(target);
    } catch (err) {
      failed.push({ path: target, error: err.message });
    }
  };
  if (!manifestPath.startsWith(appDir)) remove(manifestPath);
  remove(appDir, { recursive: true });
  return { removed, failed };
}
