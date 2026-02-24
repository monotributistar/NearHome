#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CI=1 pnpm i

copy_if_missing() {
  local src="$1"
  local dest="$2"
  if [ ! -f "$dest" ]; then
    cp "$src" "$dest"
    echo "created $dest"
  else
    echo "kept $dest"
  fi
}

copy_if_missing "apps/api/.env.example" "apps/api/.env"
copy_if_missing "apps/admin/.env.example" "apps/admin/.env"
copy_if_missing "apps/portal/.env.example" "apps/portal/.env"

pnpm db:reset

echo "setup complete"
