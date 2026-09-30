#!/bin/sh
# One-time setup: stores .rgd files in git as `rgd-cli to-text` dumps via a
# clean/smudge filter (binary on disk, text in history), plus a textconv
# driver for older binary commits. Requires git + node. Safe to re-run.
# Run from inside the repo to set up (rgd-suite itself or any mod repo).
#
#   cli/setup-git-diff.sh            # this clone only
#   cli/setup-git-diff.sh --global   # every repo on this machine
exec node "$(cd "$(dirname "$0")" && pwd -P)/rgd-cli.js" git-setup "$@"
