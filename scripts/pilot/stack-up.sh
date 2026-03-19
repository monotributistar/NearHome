#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-local}"
PROFILE="${2:-}"
GENERATED_DETECTION_FILE="infra/docker-compose.detection.generated.yml"
SKIP_STATIC_DETECTION_FALLBACK="${NEARHOME_SKIP_STATIC_DETECTION_FALLBACK:-0}"
FORCE_BUILD="${NEARHOME_FORCE_BUILD:-}"

if [[ "$MODE" != "local" && "$MODE" != "onprem" && "$MODE" != "onprem-remote" ]]; then
  echo "Usage: $0 <local|onprem|onprem-remote> [observability|tunnel]" >&2
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

PROFILES=()
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy from ${ENV_FILE}.example and edit required values." >&2
  exit 1
fi

if [[ "$MODE" == "local" ]]; then
  PROFILES+=(static-detection)
elif [[ -f "$GENERATED_DETECTION_FILE" ]]; then
  echo "Using generated detection override: $GENERATED_DETECTION_FILE"
  COMPOSE_FILES+=(-f "$GENERATED_DETECTION_FILE")
elif [[ "$SKIP_STATIC_DETECTION_FALLBACK" == "1" ]]; then
  echo "Skipping static detection fallback because NEARHOME_SKIP_STATIC_DETECTION_FALLBACK=1"
else
  echo "Generated detection override not found; falling back to static detection nodes"
  PROFILES+=(static-detection)
fi

if [[ -z "$FORCE_BUILD" ]]; then
  if [[ "$MODE" == "local" ]]; then
    FORCE_BUILD="1"
  else
    FORCE_BUILD="0"
  fi
fi

if [[ -n "$PROFILE" ]]; then
  PROFILES+=("$PROFILE")
fi

ARGS=(--env-file "$ENV_FILE" "${COMPOSE_FILES[@]}")
for active_profile in "${PROFILES[@]-}"; do
  [[ -n "$active_profile" ]] || continue
  ARGS+=(--profile "$active_profile")
done
ARGS+=(up)
if [[ "$FORCE_BUILD" == "1" ]]; then
  ARGS+=(--build)
fi
ARGS+=(-d)

echo "Running: docker compose ${ARGS[*]}"
docker compose "${ARGS[@]}"
