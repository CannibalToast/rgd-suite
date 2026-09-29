@echo off
rem One-time setup: stores .rgd files in git as `rgd-cli to-text` dumps via a
rem clean/smudge filter (binary on disk, text in history), plus a textconv
rem driver for older binary commits. Requires git + node. Safe to re-run.
rem
rem   Double-click, or:  cli\setup-git-diff.cmd            (this clone only)
rem                      cli\setup-git-diff.cmd --global   (every repo on this machine)
setlocal
if /i "%~1"=="--global" (set "SCOPE=--global") else (set "SCOPE=--local")
for /f "delims=" %%R in ('git rev-parse --show-toplevel') do set "ROOT=%%R"
git -C "%ROOT%" config %SCOPE% diff.rgd.textconv "node \"%ROOT%/cli/rgd-cli.js\" to-text -o -"
git -C "%ROOT%" config %SCOPE% diff.rgd.cachetextconv true
git -C "%ROOT%" config %SCOPE% filter.rgd.clean "node \"%ROOT%/cli/rgd-cli.js\" to-text - -o -"
git -C "%ROOT%" config %SCOPE% filter.rgd.smudge "node \"%ROOT%/cli/rgd-cli.js\" from-text - -o -"
git -C "%ROOT%" config %SCOPE% filter.rgd.required true
echo rgd textconv enabled (%SCOPE%) for %ROOT%
pause
