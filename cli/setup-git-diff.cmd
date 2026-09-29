@echo off
rem One-time setup: makes `git diff`, `git log -p`, `git show` and `git log -S`
rem render .rgd binaries as readable text, via `rgd-cli to-text` as a git
rem textconv driver. Requires git + node. Safe to re-run.
rem
rem   Double-click, or:  cli\setup-git-diff.cmd            (this clone only)
rem                      cli\setup-git-diff.cmd --global   (every repo on this machine)
setlocal
if /i "%~1"=="--global" (set "SCOPE=--global") else (set "SCOPE=--local")
for /f "delims=" %%R in ('git rev-parse --show-toplevel') do set "ROOT=%%R"
git -C "%ROOT%" config %SCOPE% diff.rgd.textconv "node \"%ROOT%/cli/rgd-cli.js\" to-text -o -"
git -C "%ROOT%" config %SCOPE% diff.rgd.cachetextconv true
echo rgd textconv enabled (%SCOPE%) for %ROOT%
pause
