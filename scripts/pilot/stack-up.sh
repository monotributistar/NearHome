#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-local}"
PROFILE="${2:-}"

if [[ "$MODE" != "local" && "$MODE" != "onprem" ]]; then
  echo "Usage: $0 <local|onprem> [observability|tunnel]" >&2
  exit 1
fi

if [[ "$MODE" == "local" ]]; then
  ENV_FILE="infra/.env.local"
  COMPOSE_FILES=(-f infra/docker-compose.yml -f infra/docker-compose.local.yml)
else
  ENV_FILE="infra/.env.onprem"
  COMPOSE_FILES=(-f infra/docker-compose.yml -f infra/docker-compose.onprem.yml)
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy from ${ENV_FILE}.example and edit required values." >&2
  exit 1
fi

ARGS=(--env-file "$ENV_FILE" "${COMPOSE_FILES[@]}" up -d)
if [[ -n "$PROFILE" ]]; then
  ARGS+=(--profile "$PROFILE")
fi

echo "Running: docker compose ${ARGS[*]}"
docker compose "${ARGS[@]}"
