#!/usr/bin/env node
import { install, uninstall } from "./install.js";
import { runMcpServer } from "./mcp-server.js";
import { PACKAGE_VERSION, isMain } from "./paths.js";

export const USAGE = `Usage: claude-firefox <command>

Commands:
  install [--no-claude]    Install the bridge for Firefox and register it with Claude Code
  uninstall [--no-claude]  Remove everything install created
  mcp                      Run the MCP server on stdio (MCP clients start this)

Options:
  --version                Print the version
  --help                   Print this help`;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" && rest.length === 0) return { command: "help" };
  if (command === "--version" && rest.length === 0) return { command: "version" };
  if (command === "mcp" && rest.length === 0) return { command };
  if ((command === "install" || command === "uninstall") && rest.every((arg) => arg === "--no-claude")) return { command, claude: !rest.includes("--no-claude") };
  return { command: "usage-error" };
}

export function formatInstall({ appDir, manifestPath, claudeStatus, claudeError, claudeCommand, mcpConfig, warnings = [] }) {
  const claude = {
    registered: 'Claude Code: registered the "firefox" MCP server.',
    "not-found": `Claude Code: \`claude\` was not found on PATH. Register the server with:\n  ${claudeCommand}`,
    skipped: `Claude Code: skipped (--no-claude). Register the server with:\n  ${claudeCommand}`,
    failed: `Claude Code: registering the "firefox" MCP server failed (${claudeError}). Register it with:\n  ${claudeCommand}`,
  }[claudeStatus];
  return [
    `Installed Claude Code Bridge for Firefox ${PACKAGE_VERSION}`,
    `  App directory:     ${appDir}`,
    `  Native messaging:  ${manifestPath}`,
    ...warnings.map((warning) => `Warning: ${warning}`),
    "",
    claude,
    "",
    "Other MCP clients (Claude Desktop and others): add this to their MCP configuration:",
    JSON.stringify(mcpConfig, null, 2),
    "",
    "Install the Firefox add-on from https://github.com/llyfn/claude-in-firefox/releases/latest if you have not yet.",
  ].join("\n");
}

export function formatUninstall({ removed, failed }) {
  if (!removed.length && !failed.length) return "Nothing to remove: Claude Code Bridge for Firefox is not installed.";
  return [
    ...(removed.length ? ["Removed:", ...removed.map((item) => `  ${item}`)] : []),
    ...(failed.length ? ["Could not remove:", ...failed.map(({ path, error }) => `  ${path}: ${error}`), "Close Firefox and run uninstall again."] : []),
  ].join("\n");
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "help") console.log(USAGE);
  else if (args.command === "version") console.log(PACKAGE_VERSION);
  else if (args.command === "mcp") await runMcpServer();
  else if (args.command === "install") console.log(formatInstall(await install({ claude: args.claude })));
  else if (args.command === "uninstall") {
    const result = await uninstall({ claude: args.claude });
    console.log(formatUninstall(result));
    if (result.failed.length) process.exitCode = 1;
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(`claude-firefox: ${err.message}`);
    process.exitCode = 1;
  }
}
