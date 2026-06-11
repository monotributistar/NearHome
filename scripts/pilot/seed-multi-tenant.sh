#!/usr/bin/env bash
# =============================================================================
# NearHome POC — Multi-Tenant RTSP Seed Script
# =============================================================================
# Crea 2 tenants, cámaras RTSP, y provisiona streams simultáneamente.
# Requiere: stack NearHome corriendo (pnpm dev:stack:up o docker compose up).
#
# Uso:
#   bash scripts/pilot/seed-multi-tenant.sh
#   bash scripts/pilot/seed-multi-tenant.sh --clean  (borra datos previos)
# =============================================================================
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
STREAM_URL="${STREAM_URL:-http://localhost:3010}"
EVENT_URL="${EVENT_URL:-http://localhost:3011}"

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@nearhome.dev}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-demo1234}"

TENANT_A_NAME="${TENANT_A_NAME:-POC Tenant Alpha}"
TENANT_B_NAME="${TENANT_B_NAME:-POC Tenant Bravo}"

CAM_A1_NAME="${CAM_A1_NAME:-Alpha-Entrada}"
CAM_A2_NAME="${CAM_A2_NAME:-Alpha-Patio}"
CAM_B1_NAME="${CAM_B1_NAME:-Bravo-Pasillo}"

CAM_A1_RTSP="${CAM_A1_RTSP:-rtsp://localhost:8554/alpha-entrada}"
CAM_A2_RTSP="${CAM_A2_RTSP:-rtsp://localhost:8554/alpha-patio}"
CAM_B1_RTSP="${CAM_B1_RTSP:-rtsp://localhost:8554/bravo-pasillo}"

MONITOR_EMAIL="${MONITOR_EMAIL:-monitor@nearhome.dev}"
MONITOR_PASSWORD="${MONITOR_PASSWORD:-demo1234}"

STATE_FILE="${STATE_FILE:-/tmp/nearhome-poc-multitenant-state.json}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[seed]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[warn]${NC} $*" >&2; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

require_tools() {
  for tool in curl jq; do
    command -v "$tool" >/dev/null 2>&1 || err "$tool is required (brew install $tool)"
  done
}

# ─── API helpers ───────────────────────────────────────────────────────────

_api() {
  local method="$1" path="$2" body="${3:-}" tenant_id="${4:-}"
  local headers=(-H "Authorization: Bearer $TOKEN")
  [[ -n "$tenant_id" ]] && headers+=(-H "X-Tenant-Id: $tenant_id")
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$API_URL$path" "${headers[@]}" -H 'content-type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$API_URL$path" "${headers[@]}"
  fi
}

api_post() { _api POST "$1" "${2:-}" "${3:-}"; }
api_get()  { _api GET "$1" "" "${2:-}"; }

# ─── Health checks ─────────────────────────────────────────────────────────

wait_stack() {
  local max="${1:-20}" wait_s="${2:-3}" attempt=1
  while [[ $attempt -le $max ]]; do
    if curl -fsS "$API_URL/health" >/dev/null 2>&1 && \
       curl -fsS "$STREAM_URL/health" >/dev/null 2>&1; then
      log "Stack healthy ($attempt attempts)"
      return 0
    fi
    warn "Waiting for stack... ($attempt/$max)"
    attempt=$((attempt + 1))
    sleep "$wait_s"
  done
  err "Stack did not become healthy after $max attempts"
}

# ─── Auth ──────────────────────────────────────────────────────────────────

login_admin() {
  log "Authenticating as admin..."
  local resp
  resp=$(curl -fsS -X POST "$API_URL/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  TOKEN=$(echo "$resp" | jq -r '.accessToken')
  ADMIN_USER_ID=$(echo "$resp" | jq -r '.user.id')
  [[ -n "$TOKEN" && "$TOKEN" != "null" ]] || err "Admin login failed"
  log "Admin token obtained (userId=$ADMIN_USER_ID)"
}

# ─── Tenant management ─────────────────────────────────────────────────────

create_tenant() {
  local name="$1"
  log "Creating tenant: $name"
  local resp
  resp=$(api_post "/tenants" "{\"name\":\"$name\"}")
  local tid
  tid=$(echo "$resp" | jq -r '.data.id')
  [[ -n "$tid" && "$tid" != "null" ]] || err "Failed to create tenant $name"
  echo "$tid"
}

# ─── Camera management ─────────────────────────────────────────────────────

create_camera() {
  local tenant_id="$1" name="$2" rtsp="$3" location="${4:-}"
  log "  Camera: $name (rtsp=$rtsp)"
  local body
  body=$(jq -n --arg name "$name" --arg rtsp "$rtsp" --arg loc "$location" \
    '{name: $name, rtspUrl: $rtsp, location: $loc, isActive: true, tags: ["poc", "multi-tenant"]}')
  local resp
  resp=$(api_post "/cameras" "$body" "$tenant_id")
  local cid
  cid=$(echo "$resp" | jq -r '.data.id')
  [[ -n "$cid" && "$cid" != "null" ]] || err "Failed to create camera $name"
  echo "$cid"
}

# ─── Stream provisioning ───────────────────────────────────────────────────

provision_stream() {
  local tenant_id="$1" camera_id="$2" camera_name="$3" rtsp="$4"
  log "  Provisioning stream: $camera_name"
  local body
  body=$(jq -n --arg tid "$tenant_id" --arg cid "$camera_id" --arg rtsp "$rtsp" \
    '{tenantId: $tid, cameraId: $cid, rtspUrl: $rtsp}')
  local resp
  resp=$(curl -fsS -X POST "$STREAM_URL/provision" \
    -H 'content-type: application/json' -d "$body")
  local status
  status=$(echo "$resp" | jq -r '.data.status // .status // "unknown"')
  log "    Status: $status"
  echo "$status"
}

check_stream_health() {
  local tenant_id="$1" camera_id="$2" camera_name="$3"
  local url="$STREAM_URL/health/$tenant_id/$camera_id"
  log "  Health check: $camera_name -> $url"
  local resp
  if resp=$(curl -fsS "$url" 2>/dev/null); then
    local connectivity
    connectivity=$(echo "$resp" | jq -r '.health.connectivity // .connectivity // "unknown"')
    echo "    Connectivity: $connectivity"
    [[ "$connectivity" == "online" || "$connectivity" == "ready" ]]
  else
    warn "    Health check failed for $camera_name"
    return 1
  fi
}

# ─── Validation helper ─────────────────────────────────────────────────────

stream_token_for_camera() {
  local tenant_id="$1" camera_id="$2" token="$3"
  local resp
  resp=$(curl -fsS -X POST "$API_URL/cameras/$camera_id/stream-token" \
    -H "Authorization: Bearer $token" \
    -H "X-Tenant-Id: $tenant_id" \
    -H 'content-type: application/json' \
    -d '{}')
  local stream_token playback_url
  stream_token=$(echo "$resp" | jq -r '.token')
  playback_url=$(echo "$resp" | jq -r '.playbackUrl // empty')
  echo "${stream_token}|${playback_url}"
}

# ─── State persistence ─────────────────────────────────────────────────────

save_state() {
  local tenant_a_id="$1" cam_a1_id="$2" cam_a2_id="$3"
  local tenant_b_id="$4" cam_b1_id="$5"
  jq -n \
    --arg tenant_a_id "$tenant_a_id" \
    --arg tenant_a_name "$TENANT_A_NAME" \
    --arg cam_a1_id "$cam_a1_id" \
    --arg cam_a1_name "$CAM_A1_NAME" \
    --arg cam_a1_rtsp "$CAM_A1_RTSP" \
    --arg cam_a2_id "$cam_a2_id" \
    --arg cam_a2_name "$CAM_A2_NAME" \
    --arg cam_a2_rtsp "$CAM_A2_RTSP" \
    --arg tenant_b_id "$tenant_b_id" \
    --arg tenant_b_name "$TENANT_B_NAME" \
    --arg cam_b1_id "$cam_b1_id" \
    --arg cam_b1_name "$CAM_B1_NAME" \
    --arg cam_b1_rtsp "$CAM_B1_RTSP" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      tenants: {
        a: { id: $tenant_a_id, name: $tenant_a_name,
          cameras: [
            { id: $cam_a1_id, name: $cam_a1_name, rtspUrl: $cam_a1_rtsp },
            { id: $cam_a2_id, name: $cam_a2_name, rtspUrl: $cam_a2_rtsp }
          ]
        },
        b: { id: $tenant_b_id, name: $tenant_b_name,
          cameras: [
            { id: $cam_b1_id, name: $cam_b1_name, rtspUrl: $cam_b1_rtsp }
          ]
        }
      },
      created_at: $created_at
    }' > "$STATE_FILE"
  log "State saved to $STATE_FILE"
}

# ─── Main ──────────────────────────────────────────────────────────────────

main() {
  require_tools

  if [[ "${1:-}" == "--clean" ]]; then
    log "Cleaning previous state..."
    rm -f "$STATE_FILE"
  fi

  wait_stack 20 3
  login_admin

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  NearHome POC — Multi-Tenant RTSP Seeding"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  # ── Phase 1: Tenants ─────────────────────────────────────────────────

  log "── Phase 1: Creating tenants ──"
  TENANT_A_ID=$(create_tenant "$TENANT_A_NAME")
  TENANT_B_ID=$(create_tenant "$TENANT_B_NAME")
  log "Tenant A: $TENANT_A_ID ($TENANT_A_NAME)"
  log "Tenant B: $TENANT_B_ID ($TENANT_B_NAME)"

  # ── Phase 2: Cameras ─────────────────────────────────────────────────

  log ""
  log "── Phase 2: Creating cameras ──"
  CAM_A1_ID=$(create_camera "$TENANT_A_ID" "$CAM_A1_NAME" "$CAM_A1_RTSP" "Entrada Principal")
  CAM_A2_ID=$(create_camera "$TENANT_A_ID" "$CAM_A2_NAME" "$CAM_A2_RTSP" "Patio Trasero")
  CAM_B1_ID=$(create_camera "$TENANT_B_ID" "$CAM_B1_NAME" "$CAM_B1_RTSP" "Pasillo Central")

  # ── Phase 3: Validate cameras ────────────────────────────────────────

  log ""
  log "── Phase 3: Validating cameras (lifecycle = ready) ──"
  for cam_id in "$CAM_A1_ID" "$CAM_A2_ID"; do
    api_post "/cameras/$cam_id/validate" '{"simulate":"pass"}' "$TENANT_A_ID" >/dev/null
  done
  api_post "/cameras/$CAM_B1_ID/validate" '{"simulate":"pass"}' "$TENANT_B_ID" >/dev/null
  log "All cameras validated"

  # ── Phase 4: Provision streams ───────────────────────────────────────

  log ""
  log "── Phase 4: Provisioning RTSP streams ──"
  provision_stream "$TENANT_A_ID" "$CAM_A1_ID" "$CAM_A1_NAME" "$CAM_A1_RTSP"
  provision_stream "$TENANT_A_ID" "$CAM_A2_ID" "$CAM_A2_NAME" "$CAM_A2_RTSP"
  provision_stream "$TENANT_B_ID" "$CAM_B1_ID" "$CAM_B1_NAME" "$CAM_B1_RTSP"

  # ── Phase 5: Health checks ───────────────────────────────────────────

  log ""
  log "── Phase 5: Stream health checks ──"
  local all_healthy=true
  check_stream_health "$TENANT_A_ID" "$CAM_A1_ID" "$CAM_A1_NAME" || all_healthy=false
  check_stream_health "$TENANT_A_ID" "$CAM_A2_ID" "$CAM_A2_NAME" || all_healthy=false
  check_stream_health "$TENANT_B_ID" "$CAM_B1_ID" "$CAM_B1_NAME" || all_healthy=false

  # ── Phase 6: Cross-tenant isolation test ─────────────────────────────

  log ""
  log "── Phase 6: Cross-tenant isolation validation ──"

  # Fetch camera from Tenant B using Tenant A scope → must fail
  log "  Testing cross-tenant read (should return 404)..."
  local cross_status
  cross_status=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-Tenant-Id: $TENANT_A_ID" \
    "$API_URL/cameras/$CAM_B1_ID")
  if [[ "$cross_status" == "404" ]]; then
    log "  ✓ Cross-tenant read correctly blocked (HTTP $cross_status)"
  else
    warn "  ✗ Cross-tenant read returned HTTP $cross_status (expected 404)"
    all_healthy=false
  fi

  # Tenant A lists cameras → must NOT include Tenant B's camera
  log "  Testing camera list isolation..."
  local list_a
  list_a=$(api_get "/cameras" "$TENANT_A_ID")
  local has_b_camera
  has_b_camera=$(echo "$list_a" | jq --arg name "$CAM_B1_NAME" \
    '.data[] | select(.name == $name) | .id' 2>/dev/null)
  if [[ -z "$has_b_camera" || "$has_b_camera" == "null" ]]; then
    log "  ✓ Tenant A list correctly excludes Tenant B cameras"
  else
    warn "  ✗ Tenant A list LEAKED Tenant B camera: $has_b_camera"
    all_healthy=false
  fi

  # ── Phase 7: Concurrent stream tokens ────────────────────────────────

  log ""
  log "── Phase 7: Stream token generation (concurrent tenants) ──"
  local tok_a1
  tok_a1=$(stream_token_for_camera "$TENANT_A_ID" "$CAM_A1_ID" "$TOKEN")
  local tok_b1
  tok_b1=$(stream_token_for_camera "$TENANT_B_ID" "$CAM_B1_ID" "$TOKEN")
  log "  Tenant A / Camera 1 token: ${tok_a1:0:40}..."
  log "  Tenant B / Camera 1 token: ${tok_b1:0:40}..."

  # ── Persist state ────────────────────────────────────────────────────

  save_state "$TENANT_A_ID" "$CAM_A1_ID" "$CAM_A2_ID" "$TENANT_B_ID" "$CAM_B1_ID"

  # ── Summary ──────────────────────────────────────────────────────────

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  if $all_healthy; then
    echo -e "  ${GREEN}✓ ALL CHECKS PASSED${NC}"
  else
    echo -e "  ${RED}✗ SOME CHECKS FAILED${NC}"
  fi
  echo ""
  echo "  Tenant A ($TENANT_A_NAME): $TENANT_A_ID"
  echo "    Cam 1: $CAM_A1_NAME ($CAM_A1_ID) → $CAM_A1_RTSP"
  echo "    Cam 2: $CAM_A2_NAME ($CAM_A2_ID) → $CAM_A2_RTSP"
  echo ""
  echo "  Tenant B ($TENANT_B_NAME): $TENANT_B_ID"
  echo "    Cam 1: $CAM_B1_NAME ($CAM_B1_ID) → $CAM_B1_RTSP"
  echo ""
  echo "  State file: $STATE_FILE"
  echo "═══════════════════════════════════════════════════════════════"

  $all_healthy
}

main "$@"
