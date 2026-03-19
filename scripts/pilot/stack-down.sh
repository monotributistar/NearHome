#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-local}"
GENERATED_DETECTION_FILE="infra/docker-compose.detection.generated.yml"

if [[ "$MODE" != "local" && "$MODE" != "onprem" && "$MODE" != "onprem-remote" ]]; then
  echo "Usage: $0 <local|onprem|onprem-remote>" >&2
  exit 1
fi

if [[ "$MODE" == "local" ]]; then
  ENV_FILE="infra/.env.local"
  COMPOSE_FILES=(-f infra/docker-compose.yml -f infra/docker-compose.local.yml)
elif [[ "$MODE" == "onprem" ]]; then
  ENV_FILE="infra/.env.onprem"
  COMPOSE_FILES=(-f infra/docker-compose.yml -f infra/docker-compose.onprem.yml)
else
  ENV_FILE="infra/.env.onprem.remote"
  COMPOSE_FILES=(
    -f infra/docker-compose.yml
    -f infra/docker-compose.onprem.yml
    -f infra/docker-compose.onprem.vault-remote.yml
  )
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Using example values is not supported for teardown." >&2
  exit 1
fi

if [[ "$MODE" != "local" && -f "$GENERATED_DETECTION_FILE" ]]; then
  COMPOSE_FILES+=(-f "$GENERATED_DETECTION_FILE")
fi

ARGS=(--env-file "$ENV_FILE" "${COMPOSE_FILES[@]}")
if [[ "$MODE" == "local" ]]; then
  ARGS+=(--profile static-detection)
fi
ARGS+=(down)

echo "Running: docker compose ${ARGS[*]}"
docker compose "${ARGS[@]}"
