import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "claude_firefox_bridge";
export const EXTENSION_ID = "claude-firefox-bridge@local";

export const PACKAGE_NAME = "@llyfn/claude-in-firefox";
export const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const PIPE_NAME_FILE = "pipe-name";
export const PIPE_KEY_FILE = "pipe-key";
export const REGISTRY_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
const PIPE_NAME = /^\\\\\.\\pipe\\claude-firefox-bridge-[0-9a-f]{32}$/;
const PIPE_KEY = /^[0-9a-f]{64}$/;

export function appDirFor(homeDir = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === "darwin") return path.join(homeDir, "Library/Application Support/claude-in-firefox");
  if (platform === "linux") return path.join(homeDir, ".local/share/claude-in-firefox");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "claude-in-firefox");
  throw new Error(`Unsupported platform "${platform}": supported platforms are macOS, Linux and Windows.`);
}

export function nativeManifestPath(homeDir = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === "darwin") return path.join(homeDir, "Library/Application Support/Mozilla/NativeMessagingHosts", `${HOST_NAME}.json`);
  if (platform === "linux") return path.join(homeDir, ".mozilla/native-messaging-hosts", `${HOST_NAME}.json`);
  return path.join(appDirFor(homeDir, platform, env), `${HOST_NAME}.json`);
}

export const packageDirFor = (appDir) => path.join(appDir, "node_modules", "@llyfn", "claude-in-firefox");

// Firefox and Claude Code start the two ends with different environments, so the path must not depend on the
// environment: the home folder comes from the password database, not HOME. macOS limits a socket path to 103 bytes
// (Linux to 107), so a longer one falls back to a fixed per-user folder under /tmp.
export function socketPathFor(platform = process.platform, { homedir, uid } = os.userInfo()) {
  const inAppDir = path.join(appDirFor(homedir, platform), "run", "bridge.sock");
  return Buffer.byteLength(inAppDir) <= 103 ? inAppDir : `/tmp/claude-firefox-bridge-${uid}/bridge.sock`;
}

function readAppFile(appDir, name, pattern, what) {
  const file = path.join(appDir, name);
  let value = "";
  try {
    value = fs.readFileSync(file, "utf8").trim();
  } catch {}
  if (!pattern.test(value)) throw new Error(`No valid ${what} in ${file}. Run \`npx ${PACKAGE_NAME} install\`.`);
  return value;
}

// Every local user can list pipe names, so the name in pipe-name is not a secret: the key from bridgeKey is what authenticates the pipe's server.
export function bridgeAddress({ platform = process.platform, appDir = appDirFor(os.homedir(), platform) } = {}) {
  return platform === "win32" ? readAppFile(appDir, PIPE_NAME_FILE, PIPE_NAME, "bridge pipe name") : socketPathFor(platform);
}

export function bridgeKey({ platform = process.platform, appDir = appDirFor(os.homedir(), platform) } = {}) {
  return platform === "win32" ? readAppFile(appDir, PIPE_KEY_FILE, PIPE_KEY, "bridge key") : null;
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
