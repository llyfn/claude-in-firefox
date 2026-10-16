import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "claude_firefox_bridge";
export const EXTENSION_ID = "claude-firefox-bridge@local";
// Fixed under /tmp rather than $TMPDIR: Firefox and Claude Code start the two ends with different environments.
export const SOCKET_PATH = `/tmp/claude-firefox-bridge-${os.userInfo().uid}/bridge.sock`;

export function nativeManifestPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library/Application Support/Mozilla/NativeMessagingHosts", `${HOST_NAME}.json`);
}

export async function ensureSocketDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fsp.lstat(dir);
  if (st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid()) await fsp.chmod(dir, 0o700);
  await verifySocketDir(dir);
}

export async function verifySocketDir(dir) {
  const st = await fsp.lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} is owned by another user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} must not be accessible to other users (mode ${(st.mode & 0o777).toString(8)})`);
}

export function isMain(importMetaUrl) {
  return process.argv[1] != null && fs.realpathSync(process.argv[1]) === fileURLToPath(importMetaUrl);
}
