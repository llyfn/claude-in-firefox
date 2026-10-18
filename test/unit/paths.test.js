import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE_VERSION, REGISTRY_KEY, appDirFor, bridgeAddress, bridgeKey, nativeManifestPath, packageDirFor, socketPathFor, verifySocketDir } from "../../host/src/paths.js";

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

test("on macOS and Linux the bridge socket is in the run folder of the app directory", () => {
  assert.equal(socketPathFor("darwin", { homedir: "/Users/u", uid: 501 }), path.join("/Users/u", "Library/Application Support/claude-in-firefox/run/bridge.sock"));
  assert.equal(socketPathFor("linux", { homedir: "/home/u", uid: 1000 }), path.join("/home/u", ".local/share/claude-in-firefox/run/bridge.sock"));
});

test("a socket path longer than 103 bytes falls back to a per-user folder under /tmp", () => {
  const suffix = "/.local/share/claude-in-firefox/run/bridge.sock";
  const homeOf = (length, fill = "h") => `/${fill.repeat(length - 1)}`;
  const fits = homeOf(103 - suffix.length);
  assert.equal(socketPathFor("linux", { homedir: fits, uid: 1000 }), path.join(fits, suffix));
  assert.equal(socketPathFor("linux", { homedir: homeOf(104 - suffix.length), uid: 1000 }), "/tmp/claude-firefox-bridge-1000/bridge.sock");
  assert.equal(socketPathFor("linux", { homedir: `${fits.slice(0, -1)}\u00e9`, uid: 1000 }), "/tmp/claude-firefox-bridge-1000/bridge.sock");
  assert.equal(socketPathFor("darwin", { homedir: `/Users/${"u".repeat(200)}`, uid: 501 }), "/tmp/claude-firefox-bridge-501/bridge.sock");
});

test("on macOS and Linux the bridge is the socket in the current user's home from the password database, whatever HOME says", (t) => {
  const { homedir } = os.userInfo();
  const home = process.env.HOME;
  process.env.HOME = path.join(tempRoot(), "elsewhere");
  t.after(() => { process.env.HOME = home; });
  assert.equal(bridgeAddress({ platform: "linux", appDir: "/nowhere" }), path.join(homedir, ".local/share/claude-in-firefox/run/bridge.sock"));
  assert.equal(bridgeAddress({ platform: "darwin", appDir: "/nowhere" }), path.join(homedir, "Library/Application Support/claude-in-firefox/run/bridge.sock"));
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

test("on macOS and Linux there is no bridge key", () => {
  assert.equal(bridgeKey({ platform: "linux", appDir: "/nowhere" }), null);
  assert.equal(bridgeKey({ platform: "darwin", appDir: "/nowhere" }), null);
});

test("on Windows the bridge key is the one in the app directory, and a missing or malformed key says to install", () => {
  const appDir = tempRoot();
  const key = "0f".repeat(32);
  assert.throws(() => bridgeKey({ platform: "win32", appDir }), /No valid bridge key in .*pipe-key\. Run `npx @llyfn\/claude-in-firefox install`\./);
  fs.writeFileSync(path.join(appDir, "pipe-key"), `${key}\r\n`);
  assert.equal(bridgeKey({ platform: "win32", appDir }), key);
  fs.writeFileSync(path.join(appDir, "pipe-key"), `${key.toUpperCase()}\n`);
  assert.throws(() => bridgeKey({ platform: "win32", appDir }), /No valid bridge key/);
  fs.writeFileSync(path.join(appDir, "pipe-key"), `${key.slice(2)}\n`);
  assert.throws(() => bridgeKey({ platform: "win32", appDir }), /No valid bridge key/);
});
