# AGENTS.md

## Cursor Cloud specific instructions

This is a VS Code extension (RGD Suite) for Relic Game Data files. There are no external services, databases, or Docker dependencies.

### Quick reference

| Task | Command |
|---|---|
| Install deps | `npm install` |
| Build | `npm run build` |
| Watch (dev) | `npm run watch` |
| Test | `npm test` |
| Type check | `npx tsc --noEmit` |
| Package VSIX | `npm run package` |
| Build + package | `npm run build-all` |

### Notes

- The bundled RGD tools library lives in `bundled/rgd-tools/dist/` and is pre-compiled (checked into the repo). Do not attempt to rebuild it.
- The standalone CLI at `cli/rgd-cli.js` can be used to exercise core RGD conversion logic without VS Code (e.g. `node cli/rgd-cli.js hash "unit_name"`).
- `npm test` runs the full suite: roundtrip, validators, task scheduling, batch validate, package menus, CLI parity, SGA path safety, and table-diff unit tests.
- `node test/roundtrip.js` exercises all conversion paths (binary, text, Lua) and verifies roundtrip identity.
- Full end-to-end extension testing requires VS Code's Extension Development Host (F5 launch), which is not available in headless cloud environments. Use the CLI and roundtrip test to validate logic changes.
- `npm run package` produces `.vsix` files in the workspace root; these are gitignored and should be cleaned up after verification.
- Pushing a `v*.*.*` tag (or running the Release workflow manually) builds and publishes a GitHub release with the VSIX.
- **aislop notes:** `import "vscode"` is correct for extension-host code (typed via `@types/vscode`, not a runtime npm dep). CLI `console.log` is intentional product output — do **not** strip it via `aislop fix`. Webview API is `globalThis['acquireVsCodeApi']()`. Prefer `aislop scan` over blind `aislop fix` on this repo.
- **Devin Stop hook:** `.devin/hooks.v1.json` runs `.devin/hooks/aislop-scan.ps1` on agent **Stop**. Full log is written to `.devin/aislop-last-scan.txt`. Verify with `/hooks` in Devin Desktop/CLI.
