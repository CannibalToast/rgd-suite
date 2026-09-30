@echo off
rem One-time setup: stores .rgd files in git as `rgd-cli to-text` dumps via a
rem clean/smudge filter (binary on disk, text in history), plus a textconv
rem driver for older binary commits. Requires git + node. Safe to re-run.
rem Run from inside the repo to set up (rgd-suite itself or any mod repo).
rem
rem   Double-click, or:  cli\setup-git-diff.cmd            (this clone only)
rem                      cli\setup-git-diff.cmd --global   (every repo on this machine)
node "%~dp0rgd-cli.js" git-setup %*
pause
