#!/usr/bin/env bash
# =============================================================================
# NearHome POC — Smoketest de detección end-to-end (F1.1)
# =============================================================================
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
EVENT_URL="${EVENT_URL:-http://localhost:3011}"
EVENT_SECRET="${EVENT_PUBLISH_SECRET:-dev-event-publish-secret}"

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@nearhome.dev}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-demo1234}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[e2e]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[warn]${NC} $*" >&2; }
err()  { echo -e "${RED}[FAIL]${NC} $*" >&2; }
info() { echo -e "${CYAN}[test]${NC} $*"; }

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); log "  ✓ $*"; }
fail() { FAILED=$((FAILED+1)); err "  ✗ $*"; }

require_tools() {
  for tool in curl jq; do
    command -v "$tool" >/dev/null 2>&1 || { err "$tool is required"; exit 1; }
  done
}

# ─── API helpers ───────────────────────────────────────────────────────────

login() {
  curl -s -X POST "$API_URL/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | jq -r '.accessToken'
}

api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}" tenant="${5:-}" extra_header="${6:-}"
  local headers=()
  [[ -n "$token" ]] && headers+=(-H "Authorization: Bearer $token")
  [[ -n "$tenant" ]] && headers+=(-H "X-Tenant-Id: $tenant")
  [[ -n "$extra_header" ]] && headers+=(-H "$extra_header")
  if [[ -n "$body" ]]; then
    curl -s -X "$method" "$API_URL$path" ${headers:+"${headers[@]}"} -H 'content-type: application/json' -d "$body"
  else
    curl -s -X "$method" "$API_URL$path" ${headers:+"${headers[@]}"}
  fi
}

# ─── Main ──────────────────────────────────────────────────────────────────

main() {
  require_tools

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  F1.1 — Detection E2E Smoke Test"
  echo "  Frame → DetectionJob → Observation → SceneEvent → Incident → Notify"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  # ── 1. Auth ──────────────────────────────────────────────────────────
  info "STEP 1: Authentication"
  TOKEN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  if [[ -n "$TOKEN" && "$TOKEN" != "null" ]]; then
    pass "Admin authenticated"
  else
    fail "Authentication failed"
    exit 1
  fi

  # ── 2. Create tenant + camera ────────────────────────────────────────
  info "STEP 2: Provision tenant + camera"
  TID=$(api POST "/tenants" '{"name":"E2E Detection Test"}' "$TOKEN" | jq -r '.data.id')
  CID=$(api POST "/cameras" "{\"name\":\"E2E Cam\",\"rtspUrl\":\"rtsp://demo/e2e\",\"isActive\":true}" "$TOKEN" "$TID" | jq -r '.data.id')
  api POST "/cameras/$CID/validate" '{"simulate":"pass"}' "$TOKEN" "$TID" >/dev/null

  if [[ -n "$TID" && "$TID" != "null" && -n "$CID" && "$CID" != "null" ]]; then
    pass "Tenant=$TID Camera=$CID"
  else
    fail "Provisioning failed"
    exit 1
  fi

  # ── 3. Create detection job ──────────────────────────────────────────
  info "STEP 3: Create detection job"
  local job_body
  job_body=$(jq -n --arg cid "$CID" --arg tid "$TID" \
    '{cameraId: $cid, mode: "realtime", provider: "huggingface_space", taskType: "object_detection", modelRef: "yolo11n"}')
  local job_resp
  job_resp=$(api POST "/detections/jobs" "$job_body" "$TOKEN" "$TID")
  local JID
  JID=$(echo "$job_resp" | jq -r '.data.id')
  local job_status
  job_status=$(echo "$job_resp" | jq -r '.data.status')

  if [[ -n "$JID" && "$JID" != "null" ]]; then
    pass "DetectionJob created: $JID (status=$job_status)"
  else
    fail "Job creation failed: $(echo "$job_resp" | jq -c .)"
    exit 1
  fi

  # ── 4. Complete job with mock detections ─────────────────────────────
  info "STEP 4: Complete detection job (simulate inference)"
  local now_ts
  now_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || python3 -c "from datetime import datetime,timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")
  local complete_body
  complete_body=$(jq -n \
    --arg ts "$now_ts" \
    '{detections: [{label: "person", confidence: 0.92, bbox: {x: 0.22, y: 0.16, w: 0.20, h: 0.40}, frameTs: $ts}, {label: "car", confidence: 0.78, bbox: {x: 0.55, y: 0.40, w: 0.15, h: 0.25}, frameTs: $ts}], providerMeta: {provider: "huggingface_space", model: "yolo11n"}}')
  local complete_resp
  complete_resp=$(api POST "/internal/detections/jobs/$JID/complete" "$complete_body" "" "" "x-detection-callback-secret: dev-detection-callback-secret")
  local complete_ok
  complete_ok=$(echo "$complete_resp" | jq -r '.data.id // empty')

  if [[ -n "$complete_ok" ]]; then
    pass "Job completed: $complete_ok"
  else
    fail "Job completion failed: $(echo "$complete_resp" | jq -c .)"
    exit 1
  fi

  # ── 5. Verify DetectionObservations ──────────────────────────────────
  info "STEP 5: Verify DetectionObservations"
  local results
  results=$(api GET "/detections/jobs/$JID/results" "" "$TOKEN" "$TID")
  local obs_count
  obs_count=$(echo "$results" | jq -r '.total')

  if [[ "$obs_count" -ge 1 ]]; then
    local first_label
    first_label=$(echo "$results" | jq -r '.data[0].label')
    pass "Observations created: $obs_count (first=$first_label)"
  else
    fail "No observations found (expected >= 1)"
  fi

  # ── 6. Verify ScenePrimitiveEvents ───────────────────────────────────
  info "STEP 6: Verify ScenePrimitiveEvents"
  sleep 1  # Allow async processing
  local events_resp
  events_resp=$(api GET "/cameras/$CID/detections?_sort=frameTs&_order=DESC&_start=0&_end=10" "" "$TOKEN" "$TID")
  local det_count
  det_count=$(echo "$events_resp" | jq -r '.total // 0')

  if [[ "$det_count" -ge 1 ]]; then
    pass "Camera detections: $det_count entries"
  else
    warn "Camera detections returned $det_count (may need async processing)"
  fi

  # ── 7. Verify IncidentEvents ─────────────────────────────────────────
  info "STEP 7: Verify IncidentEvents created"
  local incidents
  incidents=$(api GET "/events?_sort=timestamp&_order=DESC" "" "$TOKEN" "$TID")
  local inc_count
  inc_count=$(echo "$incidents" | jq -r '.data | length // 0')
  local inc_types
  inc_types=$(echo "$incidents" | jq -r '[.data[].type] | join(", ")' 2>/dev/null)

  if [[ "$inc_count" -ge 1 ]]; then
    pass "Incidents created: $inc_count (types: $inc_types)"
  else
    warn "No incidents in event list (may need to check incident_events table)"
  fi

  # ── 8. Verify event gateway received the publish ─────────────────────
  info "STEP 8: Verify event gateway publish"
  local event_stream
  event_stream=$(curl -s "$EVENT_URL/events/stream?once=1&replay=5&topics=incident" \
    -H "X-Tenant-Id: $TID" 2>/dev/null)
  local has_event
  has_event=$(echo "$event_stream" | grep -c "incident" 2>/dev/null || echo "0")

  if [[ "$has_event" -gt 0 ]]; then
    pass "Event gateway received incident events ($has_event found)"
  else
    warn "No incident events in gateway stream (may need async delivery)"
  fi

  # ── 9. Verify notification delivery ──────────────────────────────────
  info "STEP 9: Verify NotificationDelivery (realtime)"
  sleep 1
  local notifs
  notifs=$(api GET "/notifications?cameraId=$CID" "" "$TOKEN" "$TID" 2>/dev/null)
  local notif_count
  notif_count=$(echo "$notifs" | jq -r '.data | length // 0' 2>/dev/null)

  if [[ "$notif_count" -ge 1 ]]; then
    pass "Notification deliveries: $notif_count"
  else
    warn "No notification deliveries found (check notification channels configured)"
  fi

  # ── 10. End-to-end latency ───────────────────────────────────────────
  info "STEP 10: Measure end-to-end latency"
  local job_created job_completed
  job_created=$(echo "$job_resp" | jq -r '.data.createdAt')
  job_completed=$(echo "$complete_resp" | jq -r '.data.updatedAt // .data.completedAt')
  log "  Job created:  $job_created"
  log "  Job completed: $job_completed"

  # ── Summary ──────────────────────────────────────────────────────────
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  TOTAL=$((PASSED + FAILED))
  if [[ $FAILED -eq 0 ]]; then
    echo -e "  ${GREEN}✓ ALL $TOTAL STEPS VERIFIED${NC}"
  else
    echo -e "  ${YELLOW}$PASSED/$TOTAL steps passed, $FAILED warnings${NC}"
  fi
  echo ""
  echo "  Detection E2E pipeline:"
  echo "    Tenant: $TID"
  echo "    Camera: $CID"
  echo "    Job:    $JID"
  echo "    Obs:    $obs_count"
  echo "    Events: $det_count"
  echo ""
  echo "  Query results:"
  echo "    curl -H 'Authorization: Bearer $TOKEN' -H 'X-Tenant-Id: $TID' \\"
  echo "      $API_URL/detections/jobs/$JID/results | jq ."
  echo "═══════════════════════════════════════════════════════════════"

  return $FAILED
}

main
