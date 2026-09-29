#!/bin/sh
# One-time setup: makes `git diff`, `git log -p`, `git show` and `git log -S`
# render .rgd binaries as readable text, via `rgd-cli to-text` as a git
# textconv driver. Requires git + node. Safe to re-run.
#
#   cli/setup-git-diff.sh            # this clone only
#   cli/setup-git-diff.sh --global   # every repo on this machine
set -e
scope=${1:---local}
root=$(git rev-parse --show-toplevel)
git -C "$root" config "$scope" diff.rgd.textconv "node \"$root/cli/rgd-cli.js\" to-text -o -"
git -C "$root" config "$scope" diff.rgd.cachetextconv true
echo "rgd textconv enabled ($scope) for $root"
