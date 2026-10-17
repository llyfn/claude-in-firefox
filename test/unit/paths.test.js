import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE_VERSION, REGISTRY_KEY, SOCKET_PATH, appDirFor, bridgeAddress, nativeManifestPath, packageDirFor, verifySocketDir } from "../../host/src/paths.js";

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "cfb-paths-"));

test("verifySocketDir accepts a private directory owned by the current user", { skip: process.platform === "win32" && "Unix sockets and file modes" }, async () => {
  const dir = path.join(tempRoot(), "private");
  fs.mkdirSync(dir, { mode: 0o700 });
  await verifySocketDir(dir);
});

test("verifySocketDir rejects a missing directory", async () => {
  await assert.rejects(verifySocketDir(path.join(tempRoot(), "missing")), { code: "ENOENT" });
});

test("verifySocketDir rejects a symlink to a directory", { skip: process.platform === "win32" && "Unix sockets and file modes" }, async () => {
  const root = tempRoot();
  const target = path.join(root, "target");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, path.join(root, "link"));
  await assert.rejects(verifySocketDir(path.join(root, "link")), /is not a directory/);
});

test("verifySocketDir rejects a directory that other users can access", { skip: process.platform === "win32" && "Unix sockets and file modes" }, async () => {
  const dir = path.join(tempRoot(), "open");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o755);
  await assert.rejects(verifySocketDir(dir), /must not be accessible to other users \(mode 755\)/);
});

test("app directories, manifest paths and the package copy are per platform", () => {
  assert.equal(appDirFor("/home/u", "darwin"), path.join("/home/u", "Library/Application Support/claude-in-firefox"));
  assert.equal(appDirFor("/home/u", "linux"), path.join("/home/u", ".local/share/claude-in-firefox"));
  assert.equal(appDirFor("/home/u", "win32", { LOCALAPPDATA: "/la" }), path.join("/la", "claude-in-firefox"));
  assert.equal(appDirFor("/home/u", "win32", {}), path.join("/home/u", "AppData", "Local", "claude-in-firefox"));
  assert.throws(() => appDirFor("/home/u", "aix"), /Unsupported platform "aix": supported platforms are macOS, Linux and Windows/);
  assert.equal(nativeManifestPath("/home/u", "darwin"), path.join("/home/u", "Library/Application Support/Mozilla/NativeMessagingHosts/claude_firefox_bridge.json"));
  assert.equal(nativeManifestPath("/home/u", "linux"), path.join("/home/u", ".mozilla/native-messaging-hosts/claude_firefox_bridge.json"));
  assert.equal(nativeManifestPath("/home/u", "win32", { LOCALAPPDATA: "/la" }), path.join("/la", "claude-in-firefox", "claude_firefox_bridge.json"));
  assert.equal(packageDirFor("/app"), path.join("/app", "node_modules", "@llyfn", "claude-in-firefox"));
  assert.equal(REGISTRY_KEY, "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\claude_firefox_bridge");
  assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+$/);
});

test("on macOS and Linux the bridge is the per-user Unix socket", () => {
  assert.equal(bridgeAddress({ platform: "linux", appDir: "/nowhere" }), SOCKET_PATH);
  assert.equal(bridgeAddress({ platform: "darwin", appDir: "/nowhere" }), SOCKET_PATH);
});

test("on Windows the bridge is the pipe named in the app directory, and a missing or malformed name says to install", () => {
  const appDir = tempRoot();
  const pipe = `\\\\.\\pipe\\claude-firefox-bridge-${"a1".repeat(16)}`;
  assert.throws(() => bridgeAddress({ platform: "win32", appDir }), /No valid bridge pipe name in .*pipe-name\. Run `npx @llyfn\/claude-in-firefox install`\./);
  fs.writeFileSync(path.join(appDir, "pipe-name"), `${pipe}\r\n`);
  assert.equal(bridgeAddress({ platform: "win32", appDir }), pipe);
  fs.writeFileSync(path.join(appDir, "pipe-name"), "\\\\.\\pipe\\something-else\n");
  assert.throws(() => bridgeAddress({ platform: "win32", appDir }), /No valid bridge pipe name/);
});
