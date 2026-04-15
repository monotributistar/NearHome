#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ENV_DIR="$(dirname "$SCRIPT_DIR")"

cd "$TEST_ENV_DIR"

echo "▶ Stopping test environment..."

# Stop generated compose if it exists
if [[ -f docker-compose.generated.yml ]]; then
  docker compose -f docker-compose.generated.yml down -v --remove-orphans 2>/dev/null || true
  rm -f docker-compose.generated.yml
fi

# Stop default compose
docker compose -f docker-compose.yml down -v --remove-orphans 2>/dev/null || true

echo "✓ Test environment stopped and cleaned up."
