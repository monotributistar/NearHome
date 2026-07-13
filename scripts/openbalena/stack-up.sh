#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-base}"

if [[ "$MODE" != "base" && "$MODE" != "tunnel" ]]; then
  echo "Usage: $0 <base|tunnel>" >&2
  exit 1
fi

ENV_FILE="infra/openbalena/.env"
COMPOSE_FILES=(-f infra/openbalena/docker-compose.yml)

if [[ "$MODE" == "tunnel" ]]; then
  COMPOSE_FILES+=(-f infra/openbalena/docker-compose.cloudflare-tunnel.yml)
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy from ${ENV_FILE}.example and configure values." >&2
  exit 1
fi

ARGS=(--env-file "$ENV_FILE" "${COMPOSE_FILES[@]}" up -d)

echo "Running: docker compose ${ARGS[*]}"
docker compose "${ARGS[@]}"
