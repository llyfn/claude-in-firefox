import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifySocketDir } from "../../host/src/paths.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "cfb-paths-"));

test("verifySocketDir accepts a private directory owned by the current user", async () => {
  const dir = path.join(tempRoot(), "private");
  fs.mkdirSync(dir, { mode: 0o700 });
  await verifySocketDir(dir);
});

test("verifySocketDir rejects a missing directory", async () => {
  await assert.rejects(verifySocketDir(path.join(tempRoot(), "missing")), { code: "ENOENT" });
});

test("verifySocketDir rejects a symlink to a directory", async () => {
  const root = tempRoot();
  const target = path.join(root, "target");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, path.join(root, "link"));
  await assert.rejects(verifySocketDir(path.join(root, "link")), /is not a directory/);
});

test("verifySocketDir rejects a directory that other users can access", async () => {
  const dir = path.join(tempRoot(), "open");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o755);
  await assert.rejects(verifySocketDir(dir), /must not be accessible to other users \(mode 755\)/);
});
