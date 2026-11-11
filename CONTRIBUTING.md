# Contributing

## Development

Development needs Node 22.22 or newer.

```bash
npm install
npm test                               # unit tests
npm run lint                           # web-ext lint
npm run install-host -- --no-claude    # install this clone like a release
npm run e2e                            # drive a real Firefox Developer Edition
npm run build                          # package the add-on into web-ext-artifacts/
```

- **e2e** needs Firefox Developer Edition and a prior `npm run install-host -- --no-claude`. On Linux, set `FIREFOX_BIN` to its path. Don't run e2e while another Firefox has the add-on installed, because only one native host can run at a time.
- **Unsigned builds** need Developer Edition or Nightly with `xpinstall.signatures.required` set to `false`. Install the `.zip` from `web-ext-artifacts/` through `about:addons` → gear menu → *Install Add-on From File…*.
- After you change anything under `host/src`, run `npm run install-host` again.
- **Design notes** are in [`docs/superpowers/specs/`](docs/superpowers/specs/).

## Releasing (maintainers)

`.github/workflows/release.yml` submits the add-on to addons.mozilla.org as a listed add-on, publishes `@llyfn/claude-in-firefox` to npm, and creates a GitHub release.

Every release also sends the listing in `amo-metadata.json`, so edit the listing there; changes made on addons.mozilla.org are overwritten. Screenshots and the icon are set in the [Developer Hub](https://addons.mozilla.org/developers/addons).

One-time setup: store three secrets in the repository's `release` environment, for example with `gh secret set NPM_TOKEN --env release`:
- `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, the API credentials from <https://addons.mozilla.org/developers/addon/api/key/>;
- `NPM_TOKEN`, an npm granular access token with read and write access to `@llyfn/claude-in-firefox` and "Bypass two-factor authentication" ticked. Write tokens expire within 90 days, so check it before each release.

Only `v*` tags on `main` can use that environment, and each run waits for a maintainer's approval.

For each release:

1. Bump `version` in both `extension/manifest.json` and `package.json`. addons.mozilla.org won't sign a version twice.
2. Commit, then push a matching tag, for example `git tag v0.3.0 && git push origin v0.3.0`.
3. Approve the run in the Actions tab. The workflow then checks that the versions match the tag, runs the tests and lint, checks the npm token, submits the add-on, publishes to npm with provenance, and creates the release.

The npm package is live as soon as the run ends, but a new add-on version, and on the first release the listing page itself, reaches users only after Mozilla reviews it. Firefox then updates the add-on on its own, while the bridge changes only when users run the installer again. So each add-on version has to work with older bridges, and each bridge with the add-on version before it.
