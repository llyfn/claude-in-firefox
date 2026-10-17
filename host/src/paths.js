import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "claude_firefox_bridge";
export const EXTENSION_ID = "claude-firefox-bridge@local";
// Fixed under /tmp rather than $TMPDIR: Firefox and Claude Code start the two ends with different environments.
export const SOCKET_PATH = `/tmp/claude-firefox-bridge-${os.userInfo().uid}/bridge.sock`;

export const PACKAGE_NAME = "@llyfn/claude-in-firefox";
export const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const PIPE_NAME_FILE = "pipe-name";
export const REGISTRY_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
const PIPE_NAME = /^\\\\\.\\pipe\\claude-firefox-bridge-[0-9a-f]{32}$/;

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

// Node cannot restrict a named pipe to one user, so on Windows the pipe's name is a secret kept in the user's profile.
export function bridgeAddress({ platform = process.platform, appDir = appDirFor(os.homedir(), platform) } = {}) {
  if (platform !== "win32") return SOCKET_PATH;
  const file = path.join(appDir, PIPE_NAME_FILE);
  let name = "";
  try {
    name = fs.readFileSync(file, "utf8").trim();
  } catch {}
  if (!PIPE_NAME.test(name)) throw new Error(`No valid bridge pipe name in ${file}. Run \`npx ${PACKAGE_NAME} install\`.`);
  return name;
}

export function installLocations(homeDir = os.homedir(), platform = process.platform) {
  if (platform === "darwin") {
    return {
      manifestDir: path.join(homeDir, "Library/Application Support/Mozilla/NativeMessagingHosts"),
      hostDir: path.join(homeDir, "Library/Application Support/claude-in-firefox/host"),
    };
  }
  if (platform === "linux") {
    return {
      manifestDir: path.join(homeDir, ".mozilla/native-messaging-hosts"),
      hostDir: path.join(homeDir, ".local/share/claude-in-firefox/host"),
    };
  }
  throw new Error(`Unsupported platform "${platform}": the installer supports macOS and Linux.`);
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
