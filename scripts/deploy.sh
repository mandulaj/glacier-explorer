#!/usr/bin/env bash
# Build the viewer and publish it to the gh-pages branch (GitHub Pages).
#
# The published branch holds a single commit with the built site, including
# the generated data frames from web/public/data/ (about 460 MB). It is
# force-pushed on every deploy, so the repository does not grow with each
# data rebuild, and the raw NetCDF files never leave this machine.
#
# Usage: scripts/deploy.sh [remote]     (default remote: origin)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
remote="${1:-origin}"
url="$(git -C "$root" remote get-url "$remote")"

if [ ! -f "$root/web/public/data/manifest.json" ]; then
  echo "No data in web/public/data/. Run the pipeline first (see README)." >&2
  exit 1
fi

cd "$root/web"
[ -d node_modules ] || npm ci
npm run build

site="$(mktemp -d)"
trap 'rm -rf "$site"' EXIT
cp -r dist/. "$site"
touch "$site/.nojekyll"

cd "$site"
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy $(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo 'working tree')"
echo "Pushing $(du -sh . | cut -f1) to $url (gh-pages) ..."
git push -f "$url" gh-pages
echo "Done. The site updates a minute or two after the push."
