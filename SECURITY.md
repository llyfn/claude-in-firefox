# Security policy

## Reporting a vulnerability

Report vulnerabilities privately with **Report a vulnerability** on this repository's [Security tab](https://github.com/llyfn/claude-in-firefox/security). Do not open a public issue, pull request or discussion about one.

## Supported versions

Fixes go into the latest release only. Update with `npx @llyfn/claude-in-firefox@latest install` and the `.xpi` from the [latest release](https://github.com/llyfn/claude-in-firefox/releases/latest).

## Scope

- The Firefox add-on (`extension/`)
- The native host and the MCP server (`host/src/native-host.js`, `host/src/mcp-server.js`)
- The installer (`npx @llyfn/claude-in-firefox install` and `uninstall`)

## Known limitations

These are known and documented, and are not treated as vulnerabilities:

- **Prompt injection.** A web page can contain text written to steer Claude. See [Safety](README.md#safety) in the README.
- **No domain blocking.** By design the add-on blocks no sites and asks for no per-site permission; Claude Code's own permission settings are the only gate.
- **Running the installer inside a project.** npx puts the `node_modules/.bin` folders of the current project and its parent folders first on PATH and starts the installer with the first `node` on that PATH, so a `node` provided by a package in that project runs instead of yours. The installer skips `node_modules` folders when it looks for the `node` to record and the `claude` to run, but nothing in the package can replace the interpreter that starts it. Run the install command from your home folder.
- **Windows pipe impersonation.** On Windows, a program that holds SeImpersonatePrivilege (administrators, service accounts) and serves the bridge's pipe name while the native host is down could impersonate you when the MCP server connects. Node cannot set the client's impersonation level.
