# AGENTS.md

## Cursor Cloud specific instructions

This is a VS Code extension (RGD Suite) for Relic Game Data files. There are no external services, databases, or Docker dependencies.

### Quick reference

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Build | `npm run build` |
| Watch (dev) | `npm run watch` |
| Test | `node test/roundtrip.js` |
| Type check | `npx tsc --noEmit` |
| Package VSIX | `npm run package` |
| Build + package | `npm run build-all` |

### Notes

- The bundled RGD tools library lives in `bundled/rgd-tools/dist/` and is pre-compiled (checked into the repo). Do not attempt to rebuild it.
- The standalone CLI at `cli/rgd-cli.js` can be used to exercise core RGD conversion logic without VS Code (e.g. `node cli/rgd-cli.js hash "unit_name"`).
- `node test/roundtrip.js` is the only automated test; it exercises all conversion paths (binary, text, Lua) and verifies roundtrip identity. All 9 checks must pass.
- Full end-to-end extension testing requires VS Code's Extension Development Host (F5 launch), which is not available in headless cloud environments. Use the CLI and roundtrip test to validate logic changes.
- `npm run package` produces `.vsix` files in the workspace root; these are gitignored and should be cleaned up after verification.
