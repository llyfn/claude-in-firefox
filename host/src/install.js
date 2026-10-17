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
