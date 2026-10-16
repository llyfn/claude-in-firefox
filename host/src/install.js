import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, HOST_NAME, isMain, nativeManifestPath } from "./paths.js";

const REPO_DIR = fileURLToPath(new URL("../../", import.meta.url));

// process.execPath is the versioned Cellar path under Homebrew, which `brew upgrade node` deletes. The first `node` on PATH is the stable symlink.
export function stableNodePath(env = process.env) {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "node");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return process.execPath;
}

export function install({ homeDir = os.homedir(), repoDir = REPO_DIR, nodePath = stableNodePath() } = {}) {
  // macOS privacy protection stops processes Firefox launches from reading ~/Desktop, ~/Documents and ~/Downloads, so the host runs from a copy under Application Support, launched with an absolute node path because Firefox gives hosts a minimal PATH.
  const hostDir = path.join(homeDir, "Library/Application Support/claude-in-firefox/host");
  fs.mkdirSync(hostDir, { recursive: true });
  for (const file of ["native-host.js", "framing.js", "paths.js"]) fs.copyFileSync(path.join(repoDir, "host/src", file), path.join(hostDir, file));
  fs.writeFileSync(path.join(hostDir, "package.json"), '{ "type": "module" }\n');
  const wrapperPath = path.join(hostDir, "native-host");
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${nodePath}" "${path.join(hostDir, "native-host.js")}" "$@"\n`);
  fs.chmodSync(wrapperPath, 0o755);

  const manifestPath = nativeManifestPath(homeDir);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = { name: HOST_NAME, description: "Firefox Bridge for Claude Code", path: wrapperPath, type: "stdio", allowed_extensions: [EXTENSION_ID] };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifestPath,
    wrapperPath,
    hostDir,
    mcpCommand: `claude mcp add --scope user firefox -- "${nodePath}" "${path.join(repoDir, "host/src/mcp-server.js")}"`,
  };
}

if (isMain(import.meta.url)) {
  const { manifestPath, wrapperPath, hostDir, mcpCommand } = install();
  console.log(`Native messaging manifest: ${manifestPath}`);
  console.log(`Native host directory:     ${hostDir}`);
  console.log(`Native host wrapper:       ${wrapperPath}`);
  console.log(`\nRegister the MCP server with Claude Code:\n  ${mcpCommand}`);
}
