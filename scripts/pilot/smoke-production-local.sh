#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

API_URL="${API_URL:-http://localhost:3001}"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:8090}"
ADMIN_EMAIL="${DETECTION_DEPLOY_ADMIN_EMAIL:-admin@nearhome.dev}"
ADMIN_PASSWORD="${DETECTION_DEPLOY_ADMIN_PASSWORD:-demo1234}"
START_STACK="${START_STACK:-1}"
STOP_STACK_ON_EXIT="${STOP_STACK_ON_EXIT:-0}"
RUN_BASE_SMOKE="${RUN_BASE_SMOKE:-1}"
RUN_AUDIO_ASYNC_SMOKE="${RUN_AUDIO_ASYNC_SMOKE:-0}"
RUN_DETECTION_SYNC_SMOKE_IF_GENERATED="${RUN_DETECTION_SYNC_SMOKE_IF_GENERATED:-1}"
STACK_SYNC_MODE="${STACK_SYNC_MODE:-onprem-remote}"
STACK_SYNC_PROFILE="${STACK_SYNC_PROFILE:-tunnel}"
STACK_SYNC_DRY_RUN="${STACK_SYNC_DRY_RUN:-1}"

TEST_USER_NAME="${TEST_USER_NAME:-Prod Smoke User}"
TEST_USER_ROLE="${TEST_USER_ROLE:-monitor}"
TEST_USER_PASSWORD="${TEST_USER_PASSWORD:-demo1234}"
TEST_USER_EMAIL="${TEST_USER_EMAIL:-prod-smoke+$(date +%s)@nearhome.dev}"

STARTED_STACK=0
TENANT_ID=""
ADMIN_TOKEN=""
TEST_USER_ID=""
TEST_USER_TOKEN=""
ONLINE_NODE_IDS_CSV=""

require_tools() {
  command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
  command -v jq >/dev/null 2>&1 || { echo "jq is required"; exit 1; }
  command -v node >/dev/null 2>&1 || { echo "node is required"; exit 1; }
  command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required"; exit 1; }
}

cleanup() {
  if [[ "$STARTED_STACK" == "1" && "$STOP_STACK_ON_EXIT" == "1" ]]; then
    echo "Stopping local stack (STOP_STACK_ON_EXIT=1)"
    pnpm pilot:stack:down:local
  fi
}
trap cleanup EXIT

login() {
  local email="$1"
  local password="$2"
  local login_json
  login_json="$(curl -fsS -X POST "$API_URL/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$email\",\"password\":\"$password\"}")"
  node -e 'const body = JSON.parse(process.argv[1]); process.stdout.write(body.accessToken || "");' "$login_json"
}

resolve_tenant_id() {
  local me_json
  me_json="$(curl -fsS "$API_URL/auth/me" -H "authorization: Bearer $ADMIN_TOKEN")"
  TENANT_ID="$(
    node -e '
      const body = JSON.parse(process.argv[1]);
      const memberships = Array.isArray(body.memberships) ? body.memberships : [];
      process.stdout.write(memberships[0]?.tenantId || "");
    ' "$me_json"
  )"
  if [[ -z "$TENANT_ID" ]]; then
    echo "Could not resolve tenantId from /auth/me" >&2
    exit 1
  fi
}

create_test_user() {
  local payload response
  payload="$(jq -nc \
    --arg email "$TEST_USER_EMAIL" \
    --arg name "$TEST_USER_NAME" \
    --arg password "$TEST_USER_PASSWORD" \
    --arg role "$TEST_USER_ROLE" \
    '{email:$email,name:$name,password:$password,role:$role}')"

  response="$(
    curl -fsS -X POST "$API_URL/users" \
      -H "authorization: Bearer $ADMIN_TOKEN" \
      -H "x-tenant-id: $TENANT_ID" \
      -H 'content-type: application/json' \
      -d "$payload"
  )"

  TEST_USER_ID="$(node -e 'const body = JSON.parse(process.argv[1]); process.stdout.write(body.data?.id || "");' "$response")"
  if [[ -z "$TEST_USER_ID" ]]; then
    echo "User creation failed: missing user id in response" >&2
    exit 1
  fi
}

validate_test_user_access() {
  TEST_USER_TOKEN="$(login "$TEST_USER_EMAIL" "$TEST_USER_PASSWORD")"
  if [[ -z "$TEST_USER_TOKEN" ]]; then
    echo "Test user login failed" >&2
    exit 1
  fi

  local me_json
  me_json="$(curl -fsS "$API_URL/auth/me" -H "authorization: Bearer $TEST_USER_TOKEN")"
  node -e '
    const body = JSON.parse(process.argv[1]);
    const tenantId = process.argv[2];
    const memberships = Array.isArray(body.memberships) ? body.memberships : [];
    const ok = memberships.some((entry) => entry && entry.tenantId === tenantId);
    if (!ok) {
      console.error(`Created user does not have membership in tenant ${tenantId}`);
      process.exit(1);
    }
  ' "$me_json" "$TENANT_ID"

  curl -fsS "$API_URL/cameras" \
    -H "authorization: Bearer $TEST_USER_TOKEN" \
    -H "x-tenant-id: $TENANT_ID" >/tmp/nearhome_prod_smoke_user_cameras.json
}

validate_node_deploy_workflow() {
  local bridge_nodes_json deploy_bundle_json export_payload export_json stack_sync_payload stack_sync_json

  bridge_nodes_json="$(curl -fsS "$BRIDGE_URL/v1/nodes")"
  ONLINE_NODE_IDS_CSV="$(
    node -e '
      const body = JSON.parse(process.argv[1] || "{}");
      const rows = Array.isArray(body.data) ? body.data : [];
      const ids = rows
        .filter((row) => row && typeof row.nodeId === "string" && (row.status === "online" || row.status === "degraded"))
        .map((row) => row.nodeId);
      process.stdout.write(ids.join(","));
    ' "$bridge_nodes_json"
  )"

  if [[ -z "$ONLINE_NODE_IDS_CSV" ]]; then
    echo "No online detection nodes found in bridge" >&2
    exit 1
  fi

  deploy_bundle_json="$(curl -fsS "$API_URL/ops/nodes/deploy-bundle?nodeIds=$ONLINE_NODE_IDS_CSV" -H "authorization: Bearer $ADMIN_TOKEN")"
  node -e '
    const body = JSON.parse(process.argv[1] || "{}");
    const data = body.data || {};
    const definitions = Array.isArray(data.definitions) ? data.definitions : [];
    if (definitions.length === 0) {
      console.error("deploy-bundle returned no definitions");
      process.exit(1);
    }
    if (typeof data.composeYaml !== "string" || !data.composeYaml.includes("services:")) {
      console.error("deploy-bundle composeYaml is invalid");
      process.exit(1);
    }
  ' "$deploy_bundle_json"

  export_payload="$(
    node -e '
      const ids = (process.argv[1] || "").split(",").filter(Boolean);
      process.stdout.write(JSON.stringify({ nodeIds: ids }));
    ' "$ONLINE_NODE_IDS_CSV"
  )"

  export_json="$(
    curl -fsS -X POST "$API_URL/ops/nodes/deploy-bundle/export" \
      -H "authorization: Bearer $ADMIN_TOKEN" \
      -H 'content-type: application/json' \
      -d "$export_payload"
  )"
  node -e '
    const body = JSON.parse(process.argv[1] || "{}");
    const data = body.data || {};
    const exp = data.export || {};
    if (!exp.path || !String(exp.path).includes("docker-compose.detection.generated.yml")) {
      console.error("export path is missing or invalid");
      process.exit(1);
    }
    if (!Number.isFinite(exp.nodeCount) || exp.nodeCount <= 0) {
      console.error("export nodeCount is invalid");
      process.exit(1);
    }
  ' "$export_json"

  stack_sync_payload="$(
    node -e '
      const mode = process.argv[1];
      const profile = process.argv[2];
      const dryRun = process.argv[3] !== "0";
      const payload = { mode, dryRun };
      if (profile) payload.profile = profile;
      process.stdout.write(JSON.stringify(payload));
    ' "$STACK_SYNC_MODE" "$STACK_SYNC_PROFILE" "$STACK_SYNC_DRY_RUN"
  )"

  stack_sync_json="$(
    curl -fsS -X POST "$API_URL/ops/nodes/stack-sync-detection" \
      -H "authorization: Bearer $ADMIN_TOKEN" \
      -H 'content-type: application/json' \
      -d "$stack_sync_payload"
  )"
  node -e '
    const body = JSON.parse(process.argv[1] || "{}");
    const data = body.data || {};
    if (data.status !== "succeeded") {
      console.error("stack-sync did not succeed", body);
      process.exit(1);
    }
  ' "$stack_sync_json"
}

main() {
  require_tools

  if [[ "$START_STACK" == "1" ]]; then
    echo "Starting local stack for product-like simulation"
    pnpm pilot:stack:up:local
    STARTED_STACK=1
  fi

  if [[ "$RUN_BASE_SMOKE" == "1" ]]; then
    echo "Running base plane smoke"
    pnpm pilot:smoke
  fi

  ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
  if [[ -z "$ADMIN_TOKEN" ]]; then
    echo "Admin login failed" >&2
    exit 1
  fi

  resolve_tenant_id
  create_test_user
  validate_test_user_access
  validate_node_deploy_workflow

  if [[ "$RUN_DETECTION_SYNC_SMOKE_IF_GENERATED" == "1" && -f "infra/docker-compose.detection.generated.yml" ]]; then
    echo "Running generated detection sync smoke"
    DETECTION_DEPLOY_ADMIN_EMAIL="$ADMIN_EMAIL" \
      DETECTION_DEPLOY_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
      pnpm pilot:smoke:detection-sync
  fi

  if [[ "$RUN_AUDIO_ASYNC_SMOKE" == "1" ]]; then
    echo "Running async audio smoke"
    DETECTION_DEPLOY_ADMIN_EMAIL="$ADMIN_EMAIL" \
      DETECTION_DEPLOY_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
      pnpm pilot:smoke:audio:async
  fi

  echo "PROD_LOCAL_SMOKE_PASS tenant=$TENANT_ID user=$TEST_USER_EMAIL nodes=$ONLINE_NODE_IDS_CSV"
}

main "$@"
