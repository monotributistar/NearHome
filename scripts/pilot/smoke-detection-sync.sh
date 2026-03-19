#!/usr/bin/env bash
set -euo pipefail

GENERATED_FILE="${GENERATED_DETECTION_FILE:-infra/docker-compose.detection.generated.yml}"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:8090}"
API_URL="${API_URL:-http://localhost:3001}"
ADMIN_EMAIL="${DETECTION_DEPLOY_ADMIN_EMAIL:-admin@nearhome.dev}"
ADMIN_PASSWORD="${DETECTION_DEPLOY_ADMIN_PASSWORD:-}"

if [[ ! -f "$GENERATED_FILE" ]]; then
  echo "Missing generated detection compose file: $GENERATED_FILE" >&2
  exit 1
fi

GENERATED_NODE_IDS=()
while IFS= read -r node_id; do
  [[ -n "$node_id" ]] || continue
  GENERATED_NODE_IDS+=("$node_id")
done < <(awk -F'"' '/NODE_ID:/ { if (NF >= 2) print $2 }' "$GENERATED_FILE" | sort -u)

if [[ "${#GENERATED_NODE_IDS[@]}" -eq 0 ]]; then
  echo "No NODE_ID entries found in $GENERATED_FILE" >&2
  exit 1
fi

echo "Checking detection sync file: $GENERATED_FILE"
printf 'Expected node IDs: %s\n' "${GENERATED_NODE_IDS[*]}"

if [[ -n "$ADMIN_PASSWORD" ]]; then
  echo "Checking control-plane health -> $API_URL/health"
  curl -fsS "$API_URL/health" >/tmp/nearhome_detection_sync_api_health.json
fi

echo "Checking bridge nodes -> $BRIDGE_URL/v1/nodes"
BRIDGE_JSON="$(curl -fsS "$BRIDGE_URL/v1/nodes")"

node - "$BRIDGE_JSON" "${GENERATED_NODE_IDS[@]}" <<'NODE'
const bridge = JSON.parse(process.argv[2]);
const expectedNodeIds = process.argv.slice(3);
const items = Array.isArray(bridge.data) ? bridge.data : [];
const byId = new Map(items.map((item) => [item.nodeId, item]));
const missing = [];
const notOnline = [];

for (const nodeId of expectedNodeIds) {
  const node = byId.get(nodeId);
  if (!node) {
    missing.push(nodeId);
    continue;
  }
  if (node.status !== "online") {
    notOnline.push(`${nodeId}:${node.status}`);
  }
}

if (missing.length > 0 || notOnline.length > 0) {
  if (missing.length > 0) {
    console.error(`Missing nodes in bridge registry: ${missing.join(", ")}`);
  }
  if (notOnline.length > 0) {
    console.error(`Nodes not online: ${notOnline.join(", ")}`);
  }
  process.exit(1);
}

console.log(`Bridge nodes online: ${expectedNodeIds.join(", ")}`);
NODE

echo "Smoke detection sync PASS"
