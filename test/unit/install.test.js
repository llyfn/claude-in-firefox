import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { install } from "../../host/src/install.js";

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
