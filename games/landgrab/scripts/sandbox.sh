#!/bin/sh
# A private copy of the game for live checks while others edit and build
# this folder (the build empties dist/): copies the sources to DIR, links
# node_modules, builds there. Then: cd DIR && node test/live/play.ts
#
#   sh scripts/sandbox.sh /tmp/landgrab-mine
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:?a folder for the copy}"
mkdir -p "$dir"
rsync -a --delete --exclude node_modules --exclude dist "$here/" "$dir/"
ln -sfn "$here/node_modules" "$dir/node_modules"
cd "$dir" && node scripts/build.ts
