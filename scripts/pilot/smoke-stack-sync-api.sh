#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
ADMIN_EMAIL="${DETECTION_DEPLOY_ADMIN_EMAIL:-admin@nearhome.dev}"
ADMIN_PASSWORD="${DETECTION_DEPLOY_ADMIN_PASSWORD:-}"
STACK_SYNC_MODE="${STACK_SYNC_MODE:-onprem}"
STACK_SYNC_PROFILE="${STACK_SYNC_PROFILE:-}"
STACK_SYNC_DRY_RUN="${STACK_SYNC_DRY_RUN:-1}"
STACK_SYNC_TIMEOUT_MS="${STACK_SYNC_TIMEOUT_MS:-}"
STACK_SYNC_MAX_RETRIES="${STACK_SYNC_MAX_RETRIES:-}"
STACK_SYNC_RETRY_DELAY_MS="${STACK_SYNC_RETRY_DELAY_MS:-}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "Missing DETECTION_DEPLOY_ADMIN_PASSWORD" >&2
  exit 1
fi

echo "Checking control-plane health -> $API_URL/health"
curl -fsS "$API_URL/health" >/tmp/nearhome_stack_sync_api_health.json

LOGIN_JSON="$(curl -fsS -X POST "$API_URL/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
ACCESS_TOKEN="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.accessToken || "");' "$LOGIN_JSON")"

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "Could not obtain access token from $API_URL/auth/login" >&2
  exit 1
fi

PAYLOAD="$(node -e '
  const payload = {
    mode: process.argv[1],
    dryRun: process.argv[2] !== "0"
  };
  const profile = process.argv[3];
  const timeoutMsRaw = process.argv[4];
  const maxRetriesRaw = process.argv[5];
  const retryDelayMsRaw = process.argv[6];
  if (profile) payload.profile = profile;
  if (timeoutMsRaw) payload.timeoutMs = Number(timeoutMsRaw);
  if (maxRetriesRaw) payload.maxRetries = Number(maxRetriesRaw);
  if (retryDelayMsRaw) payload.retryDelayMs = Number(retryDelayMsRaw);
  process.stdout.write(JSON.stringify(payload));
' "$STACK_SYNC_MODE" "$STACK_SYNC_DRY_RUN" "$STACK_SYNC_PROFILE" "$STACK_SYNC_TIMEOUT_MS" "$STACK_SYNC_MAX_RETRIES" "$STACK_SYNC_RETRY_DELAY_MS")"

echo "Triggering stack sync via API -> mode=$STACK_SYNC_MODE profile=${STACK_SYNC_PROFILE:-default} dryRun=$STACK_SYNC_DRY_RUN"
TRIGGER_JSON="$(curl -fsS -X POST "$API_URL/ops/nodes/stack-sync-detection" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d "$PAYLOAD")"

echo "$TRIGGER_JSON" >/tmp/nearhome_stack_sync_trigger.json

for _ in $(seq 1 30); do
  STATUS_JSON="$(curl -fsS "$API_URL/ops/nodes/stack-sync-detection" -H "authorization: Bearer $ACCESS_TOKEN")"
  STATUS="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.data?.status || "");' "$STATUS_JSON")"
  if [[ "$STATUS" == "succeeded" ]]; then
    echo "$STATUS_JSON" >/tmp/nearhome_stack_sync_status.json
    break
  fi
  if [[ "$STATUS" == "failed" ]]; then
    echo "$STATUS_JSON" >/tmp/nearhome_stack_sync_status.json
    echo "Stack sync failed" >&2
    cat /tmp/nearhome_stack_sync_status.json >&2
    exit 1
  fi
  sleep 1
done

if [[ ! -f /tmp/nearhome_stack_sync_status.json ]]; then
  echo "Stack sync did not finish in time" >&2
  exit 1
fi

node - <<'NODE' /tmp/nearhome_stack_sync_status.json "$STACK_SYNC_MODE" "$STACK_SYNC_PROFILE" "$STACK_SYNC_DRY_RUN"
const fs = require("fs");
const filePath = process.argv[2];
const expectedMode = process.argv[3];
const expectedProfile = process.argv[4] || null;
const expectedDryRun = process.argv[5] !== "0";
const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
const state = body.data;
if (!state || state.status !== "succeeded") {
  console.error("Unexpected stack sync state", body);
  process.exit(1);
}
if (state.mode !== expectedMode) {
  console.error(`Unexpected mode ${state.mode}; expected ${expectedMode}`);
  process.exit(1);
}
if ((state.profile || null) !== expectedProfile) {
  console.error(`Unexpected profile ${state.profile}; expected ${expectedProfile}`);
  process.exit(1);
}
if (expectedDryRun) {
  const combinedLog = Array.isArray(state.logTail) ? state.logTail.join("\n") : "";
  if (!combinedLog.includes("dry-run")) {
    console.error("Expected dry-run marker in log tail");
    process.exit(1);
  }
}
console.log(`Stack sync API smoke PASS -> ${state.mode}${state.profile ? ` (${state.profile})` : ""}`);
NODE
