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

<!-- aislop:begin v1 hash=sha256:efce85d4041a350671ae701e144c1977 -->
# aislop — agent instructions

[aislop](https://github.com/scanaislop/aislop) is your guardrail for shipping clean, maintainable, production-grade code. It catches the patterns AI coding tools leave behind: dead imports, redundant code, duplicate logic, unsafe any-typed casts, narrative comments, swallowed errors, hidden fallbacks, oversized functions, risky security constructs — and grades the project out of 100 so regressions are visible. Treat its findings as blocking, not advisory: the goal is code a human maintainer would happily inherit.

## On every edit

A PostToolUse hook runs `aislop hook claude` after every Edit, Write, or MultiEdit. It scans the touched files and returns findings as JSON `additionalContext` shaped like `AislopFeedback` (schema `aislop.hook.v2` — score, baseline, delta, regressed, counts, findings, newSinceBaseline, suggestedActions). Act on them the same turn; the `suggestedActions` field tells you exactly what to run next.

## Severity ladder

- `error` — MUST fix this turn.
- `warning` + `fixable: true` — MUST fix this turn.
- `warning` + `fixable: false` — fix if trivially mechanical, otherwise surface in your reply.

## Rules

- `.aislop/config.yaml` — thresholds and engine toggles. Treat as authoritative; don't edit without user consent.
- `.aislop/rules.yaml` — project-specific architecture rules (may be absent). When a finding cites `architecture/*`, open this file and follow it.
- Custom rules can change between sessions. Trust what the scan returns, not a cached understanding of what the rules are.

## Principles

- Do not disable rules to pass the scan. Fix the underlying issue.
- If a finding is a false positive, leave it and explain in your reply — do not delete the rule config.
- The findings payload includes `nextSteps[]` — treat those as your plan for the turn.
<!-- aislop:end v1 -->
