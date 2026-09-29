#!/bin/sh
# One-time setup: stores .rgd files in git as `rgd-cli to-text` dumps via a
# clean/smudge filter (binary on disk, text in history), plus a textconv
# driver for older binary commits. Requires git + node. Safe to re-run.
#
#   cli/setup-git-diff.sh            # this clone only
#   cli/setup-git-diff.sh --global   # every repo on this machine
set -e
scope=${1:---local}
root=$(git rev-parse --show-toplevel)
git -C "$root" config "$scope" diff.rgd.textconv "node \"$root/cli/rgd-cli.js\" to-text -o -"
git -C "$root" config "$scope" diff.rgd.cachetextconv true
git -C "$root" config "$scope" filter.rgd.clean "node \"$root/cli/rgd-cli.js\" to-text - -o -"
git -C "$root" config "$scope" filter.rgd.smudge "node \"$root/cli/rgd-cli.js\" from-text - -o -"
git -C "$root" config "$scope" filter.rgd.required true
echo "rgd textconv enabled ($scope) for $root"
