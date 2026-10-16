import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { install } from "../../host/src/install.js";

test("install writes the native manifest, an executable wrapper and the claude mcp add command", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-repo-"));
  const result = install({ homeDir: home, repoDir: repo, nodePath: "/opt/node/bin/node" });

  assert.equal(result.manifestPath, path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")), {
    name: "claude_firefox_bridge",
    description: "Claude in Firefox bridge",
    path: path.join(repo, "host/bin/native-host"),
    type: "stdio",
    allowed_extensions: ["claude-firefox-bridge@local"],
  });
  assert.equal(fs.readFileSync(result.wrapperPath, "utf8"), `#!/bin/sh\nexec "/opt/node/bin/node" "${path.join(repo, "host/src/native-host.js")}" "$@"\n`);
  assert.equal(fs.statSync(result.wrapperPath).mode & 0o111, 0o111);
  assert.equal(result.mcpCommand, `claude mcp add --scope user firefox -- "/opt/node/bin/node" "${path.join(repo, "host/src/mcp-server.js")}"`);
});
