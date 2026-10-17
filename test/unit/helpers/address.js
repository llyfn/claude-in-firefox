import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Unix socket paths are limited to about 104 bytes, which macOS's os.tmpdir() leaves too little of.
export const tempAddress = (...dirs) => (process.platform === "win32" ? `\\\\.\\pipe\\cfb-test-${randomBytes(8).toString("hex")}` : path.join(fs.mkdtempSync("/tmp/cfb-test-"), ...dirs, "bridge.sock"));
