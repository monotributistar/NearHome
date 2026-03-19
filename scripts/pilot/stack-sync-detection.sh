#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-onprem}"
PROFILE="${2:-}"
GENERATED_DETECTION_FILE="infra/docker-compose.detection.generated.yml"

if [[ "$MODE" != "onprem" && "$MODE" != "onprem-remote" ]]; then
  echo "Usage: $0 <onprem|onprem-remote> [tunnel|observability]" >&2
  exit 1
fi

if [[ "$MODE" == "onprem" ]]; then
  ENV_FILE="infra/.env.onprem"
else
  ENV_FILE="infra/.env.onprem.remote"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy from ${ENV_FILE}.example and edit required values." >&2
  exit 1
fi

extract_env_value() {
  local key="$1"
  node -e '
    const fs = require("fs");
    const key = process.argv[1];
    const content = fs.readFileSync(process.argv[2], "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const currentKey = line.slice(0, idx).trim();
      if (currentKey !== key) continue;
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.stdout.write(value);
      process.exit(0);
    }
    process.exit(1);
  ' "$key" "$ENV_FILE"
}

API_URL="${DETECTION_DEPLOY_API_URL:-$(extract_env_value DETECTION_DEPLOY_API_URL || true)}"
API_URL="${API_URL:-http://127.0.0.1:3001}"
ADMIN_EMAIL="${DETECTION_DEPLOY_ADMIN_EMAIL:-$(extract_env_value DETECTION_DEPLOY_ADMIN_EMAIL || true)}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@nearhome.dev}"
ADMIN_PASSWORD="${DETECTION_DEPLOY_ADMIN_PASSWORD:-$(extract_env_value DETECTION_DEPLOY_ADMIN_PASSWORD || true)}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "Missing DETECTION_DEPLOY_ADMIN_PASSWORD in $ENV_FILE" >&2
  exit 1
fi

echo "Phase 1/3: bootstrapping base stack without static detection nodes"
NEARHOME_SKIP_STATIC_DETECTION_FALLBACK=1 bash scripts/pilot/stack-up.sh "$MODE" "$PROFILE"

echo "Phase 2/3: waiting for control-plane at $API_URL"
for _ in $(seq 1 30); do
  if curl -sf "$API_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -sf "$API_URL/health" >/dev/null 2>&1; then
  echo "Control-plane did not become healthy at $API_URL" >&2
  exit 1
fi

echo "Phase 3/3: exporting detection nodes from control-plane"
rm -f "$GENERATED_DETECTION_FILE"
DETECTION_API_URL="$API_URL" \
DETECTION_ADMIN_EMAIL="$ADMIN_EMAIL" \
DETECTION_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
pnpm pilot:detection:export

echo "Re-applying stack with generated detection override"
NEARHOME_SKIP_STATIC_DETECTION_FALLBACK=1 bash scripts/pilot/stack-up.sh "$MODE" "$PROFILE"
