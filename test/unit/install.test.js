import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install, stableNodePath } from "../../host/src/install.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

test("install copies the native host under Application Support and writes the manifest, wrapper and claude mcp add command", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-home-"));
  const result = install({ homeDir: home, repoDir: REPO, nodePath: "/opt/node/bin/node" });

  const hostDir = path.join(home, "Library/Application Support/claude-in-firefox/host");
  assert.equal(result.hostDir, hostDir);
  assert.equal(result.wrapperPath, path.join(hostDir, "native-host"));
  for (const file of ["native-host.js", "framing.js", "paths.js"]) {
    assert.deepEqual(fs.readFileSync(path.join(hostDir, file)), fs.readFileSync(path.join(REPO, "host/src", file)));
  }
  assert.equal(fs.readFileSync(path.join(hostDir, "package.json"), "utf8"), '{ "type": "module" }\n');

  assert.equal(result.manifestPath, path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")), {
    name: "claude_firefox_bridge",
    description: "Claude in Firefox bridge",
    path: result.wrapperPath,
    type: "stdio",
    allowed_extensions: ["claude-firefox-bridge@local"],
  });
  assert.equal(fs.readFileSync(result.wrapperPath, "utf8"), `#!/bin/sh\nexec "/opt/node/bin/node" "${path.join(hostDir, "native-host.js")}" "$@"\n`);
  assert.equal(fs.statSync(result.wrapperPath).mode & 0o777, 0o755);
  assert.equal(result.mcpCommand, `claude mcp add --scope user firefox -- "/opt/node/bin/node" "${path.join(REPO, "host/src/mcp-server.js")}"`);
});

test("stableNodePath returns the first executable node on PATH without resolving symlinks and falls back to the running node", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-path-"));
  const real = path.join(root, "Cellar/node/1.0/bin");
  const stable = path.join(root, "bin");
  const noExec = path.join(root, "noexec");
  for (const dir of [real, stable, noExec]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(real, "node"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync(path.join(real, "node"), path.join(stable, "node"));
  fs.writeFileSync(path.join(noExec, "node"), "", { mode: 0o644 });

  assert.equal(stableNodePath({ PATH: ["relative", path.join(root, "missing"), noExec, stable, real].join(path.delimiter) }), path.join(stable, "node"));
  assert.equal(stableNodePath({ PATH: path.join(root, "missing") }), process.execPath);
  assert.equal(stableNodePath({}), process.execPath);
});
