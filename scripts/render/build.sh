#!/usr/bin/env bash
# Render build: install the workspace with the pinned pnpm, then build only the given
# packages and their workspace dependencies (not the Next.js app).
#   bash scripts/render/build.sh @wa/api @wa/db
set -euo pipefail
cd "$(dirname "$0")/../.."

# The pnpm version pinned in package.json ("packageManager": "pnpm@x.y.z"), via npx so it
# works whether or not corepack or a global pnpm exists on the build image.
PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
pnpm() { npx --yes "pnpm@${PNPM_VERSION}" "$@"; }

# NODE_ENV is deliberately not production here: the build needs devDependencies (tsc).
pnpm install --frozen-lockfile
filters=()
for pkg in "$@"; do filters+=(--filter "${pkg}..."); done
pnpm "${filters[@]}" build
