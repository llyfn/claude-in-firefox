import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID, HOST_NAME, isMain, nativeManifestPath } from "./paths.js";

const REPO_DIR = fileURLToPath(new URL("../../", import.meta.url));

export function install({ homeDir = os.homedir(), repoDir = REPO_DIR, nodePath = process.execPath } = {}) {
  // Firefox starts native hosts with a minimal PATH, so the wrapper pins the absolute node binary.
  const wrapperPath = path.join(repoDir, "host/bin/native-host");
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${nodePath}" "${path.join(repoDir, "host/src/native-host.js")}" "$@"\n`);
  fs.chmodSync(wrapperPath, 0o755);

  const manifestPath = nativeManifestPath(homeDir);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = { name: HOST_NAME, description: "Claude in Firefox bridge", path: wrapperPath, type: "stdio", allowed_extensions: [EXTENSION_ID] };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifestPath,
    wrapperPath,
    mcpCommand: `claude mcp add --scope user firefox -- "${nodePath}" "${path.join(repoDir, "host/src/mcp-server.js")}"`,
  };
}

if (isMain(import.meta.url)) {
  const { manifestPath, wrapperPath, mcpCommand } = install();
  console.log(`Native messaging manifest: ${manifestPath}`);
  console.log(`Native host wrapper:       ${wrapperPath}`);
  console.log(`\nRegister the MCP server with Claude Code:\n  ${mcpCommand}`);
}
