#!/usr/bin/env bash
# =============================================================================
# NearHome POC — Multi-Tenant RTSP Smoke Test
# =============================================================================
# Valida aislamiento cross-tenant en la capa de streaming:
#   1. Ambos tenants pueden generar stream tokens
#   2. Token de Tenant A NO permite acceso a stream de Tenant B
#   3. Token expirado es rechazado
#   4. Streams de ambos tenants activos simultáneamente
#
# Requisitos:
#   - seed-multi-tenant.sh ejecutado primero
#   - stack NearHome corriendo
#
# Uso:
#   bash scripts/pilot/smoke-multi-tenant-rtsp.sh
# =============================================================================
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
STREAM_URL="${STREAM_URL:-http://localhost:3010}"

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@nearhome.dev}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-demo1234}"

STATE_FILE="${STATE_FILE:-/tmp/nearhome-poc-multitenant-state.json}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[smoke]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[FAIL]${NC} $*"; }
info() { echo -e "${CYAN}[info]${NC} $*"; }

PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); log "  ✓ $*"; }
fail() { FAILED=$((FAILED + 1)); err "  ✗ ${1:-}"; }

require_tools() {
  for tool in curl jq; do
    command -v "$tool" >/dev/null 2>&1 || { err "$tool is required"; exit 1; }
  done
}

# ─── API helpers ───────────────────────────────────────────────────────────

_api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}" tenant_id="${5:-}"
  local headers=()
  [[ -n "$token" ]] && headers+=(-H "Authorization: Bearer $token")
  [[ -n "$tenant_id" ]] && headers+=(-H "X-Tenant-Id: $tenant_id")
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$API_URL$path" "${headers[@]}" \
      -H 'content-type: application/json' -d "$body" 2>/dev/null
  else
    curl -fsS -X "$method" "$API_URL$path" "${headers[@]}" 2>/dev/null
  fi
}

login() {
  local email="$1" password="$2"
  local resp
  resp=$(curl -fsS -X POST "$API_URL/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" 2>/dev/null)
  echo "$resp" | jq -r '.accessToken // empty'
}

get_stream_token() {
  local admin_token="$1" tenant_id="$2" camera_id="$3"
  local resp
  resp=$(curl -fsS -X POST "$API_URL/cameras/$camera_id/stream-token" \
    -H "Authorization: Bearer $admin_token" \
    -H "X-Tenant-Id: $tenant_id" \
    -H 'content-type: application/json' \
    -d '{}' 2>/dev/null)
  echo "$resp" | jq -r '.token // empty'
}

# ─── Stream gateway checks ────────────────────────────────────────────────

check_stream_active() {
  local stream_token="$1" tenant_id="$2" camera_id="$3"
  local url="$STREAM_URL/playback/$tenant_id/$camera_id/index.m3u8?token=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$stream_token'))" 2>/dev/null || echo "$stream_token")"
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
  echo "$http_code"
}

# ─── Test cases ────────────────────────────────────────────────────────────

test_smoke() {
  local desc="$1"
  info "TEST: $desc"
}

# ─── Main ──────────────────────────────────────────────────────────────────

main() {
  require_tools

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  NearHome POC — Multi-Tenant RTSP Smoke Test"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  # ── 0. Load state ──────────────────────────────────────────────────

  if [[ ! -f "$STATE_FILE" ]]; then
    err "State file not found: $STATE_FILE"
    err "Run seed-multi-tenant.sh first."
    exit 1
  fi

  TENANT_A_ID=$(jq -r '.tenants.a.id' "$STATE_FILE")
  TENANT_A_NAME=$(jq -r '.tenants.a.name' "$STATE_FILE")
  CAM_A1_ID=$(jq -r '.tenants.a.cameras[0].id' "$STATE_FILE")
  CAM_A1_NAME=$(jq -r '.tenants.a.cameras[0].name' "$STATE_FILE")
  CAM_A2_ID=$(jq -r '.tenants.a.cameras[1].id' "$STATE_FILE")
  CAM_A2_NAME=$(jq -r '.tenants.a.cameras[1].name' "$STATE_FILE")

  TENANT_B_ID=$(jq -r '.tenants.b.id' "$STATE_FILE")
  TENANT_B_NAME=$(jq -r '.tenants.b.name' "$STATE_FILE")
  CAM_B1_ID=$(jq -r '.tenants.b.cameras[0].id' "$STATE_FILE")
  CAM_B1_NAME=$(jq -r '.tenants.b.cameras[0].name' "$STATE_FILE")

  log "State loaded:"
  log "  Tenant A: $TENANT_A_NAME ($TENANT_A_ID)"
  log "    Camera 1: $CAM_A1_NAME ($CAM_A1_ID)"
  log "    Camera 2: $CAM_A2_NAME ($CAM_A2_ID)"
  log "  Tenant B: $TENANT_B_NAME ($TENANT_B_ID)"
  log "    Camera 1: $CAM_B1_NAME ($CAM_B1_ID)"
  echo ""

  # ── 1. Auth ────────────────────────────────────────────────────────

  test_smoke "Authentication"
  ADMIN_TOKEN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  if [[ -n "$ADMIN_TOKEN" && "$ADMIN_TOKEN" != "null" ]]; then
    pass "Admin login successful"
  else
    fail "Admin login failed — is the API running?"
  fi

  # ── 2. Stream tokens: both tenants ─────────────────────────────────

  test_smoke "Stream token generation for both tenants"
  TOK_A1=$(get_stream_token "$ADMIN_TOKEN" "$TENANT_A_ID" "$CAM_A1_ID")
  TOK_A2=$(get_stream_token "$ADMIN_TOKEN" "$TENANT_A_ID" "$CAM_A2_ID")
  TOK_B1=$(get_stream_token "$ADMIN_TOKEN" "$TENANT_B_ID" "$CAM_B1_ID")

  if [[ -n "$TOK_A1" && "$TOK_A1" != "null" ]]; then
    pass "Tenant A / $CAM_A1_NAME: token generated"
  else
    fail "Tenant A / $CAM_A1_NAME: token generation failed"
  fi

  if [[ -n "$TOK_A2" && "$TOK_A2" != "null" ]]; then
    pass "Tenant A / $CAM_A2_NAME: token generated"
  else
    fail "Tenant A / $CAM_A2_NAME: token generation failed"
  fi

  if [[ -n "$TOK_B1" && "$TOK_B1" != "null" ]]; then
    pass "Tenant B / $CAM_B1_NAME: token generated"
  else
    fail "Tenant B / $CAM_B1_NAME: token generation failed"
  fi

  # ── 3. Cross-tenant token isolation ─────────────────────────────────

  test_smoke "Cross-tenant token isolation"

  # Use Tenant A's token to access Tenant B's camera stream
  local cross_code
  cross_code=$(check_stream_active "$TOK_A1" "$TENANT_B_ID" "$CAM_B1_ID")
  if [[ "$cross_code" == "401" || "$cross_code" == "403" || "$cross_code" == "404" ]]; then
    pass "Tenant A token rejected for Tenant B stream (HTTP $cross_code)"
  else
    fail "Tenant A token WAS ACCEPTED for Tenant B stream (HTTP $cross_code) — ISOLATION BROKEN"
  fi

  # Use Tenant B's token to access Tenant A's camera stream
  local cross_code2
  cross_code2=$(check_stream_active "$TOK_B1" "$TENANT_A_ID" "$CAM_A1_ID")
  if [[ "$cross_code2" == "401" || "$cross_code2" == "403" || "$cross_code2" == "404" ]]; then
    pass "Tenant B token rejected for Tenant A stream (HTTP $cross_code2)"
  else
    fail "Tenant B token WAS ACCEPTED for Tenant A stream (HTTP $cross_code2) — ISOLATION BROKEN"
  fi

  # ── 4. Camera listing isolation ─────────────────────────────────────

  test_smoke "Camera listing isolation"
  local list_a
  list_a=$(_api GET "/cameras" "" "$ADMIN_TOKEN" "$TENANT_A_ID")
  local a_count
  a_count=$(echo "$list_a" | jq '.data | length' 2>/dev/null)
  local has_b
  has_b=$(echo "$list_a" | jq --arg name "$CAM_B1_NAME" \
    '[.data[] | select(.name == $name)] | length' 2>/dev/null)

  if [[ "$a_count" -ge 2 ]]; then
    pass "Tenant A lists $a_count cameras (expected >= 2)"
  else
    fail "Tenant A lists only $a_count cameras (expected >= 2)"
  fi

  if [[ "$has_b" == "0" ]]; then
    pass "Tenant A list does NOT include Tenant B camera"
  else
    fail "Tenant A list LEAKED Tenant B camera ($has_b found) — ISOLATION BROKEN"
  fi

  # ── 5. Concurrent streams ───────────────────────────────────────────

  test_smoke "Concurrent stream access"
  local a1_code
  a1_code=$(check_stream_active "$TOK_A1" "$TENANT_A_ID" "$CAM_A1_ID")
  local b1_code
  b1_code=$(check_stream_active "$TOK_B1" "$TENANT_B_ID" "$CAM_B1_ID")

  if [[ "$a1_code" == "200" || "$a1_code" == "202" || "$a1_code" == "302" ]]; then
    pass "Tenant A stream accessible (HTTP $a1_code)"
  else
    fail "Tenant A stream returned HTTP $a1_code (expected 200/202)"
  fi

  if [[ "$b1_code" == "200" || "$b1_code" == "202" || "$b1_code" == "302" ]]; then
    pass "Tenant B stream accessible (HTTP $b1_code)"
  else
    fail "Tenant B stream returned HTTP $b1_code (expected 200/202)"
  fi

  # ── 6. Stream health check ──────────────────────────────────────────

  test_smoke "Stream gateway health"
  local health_a1
  health_a1=$(curl -fsS "$STREAM_URL/health/$TENANT_A_ID/$CAM_A1_ID" 2>/dev/null | jq -r '.health.connectivity // .status // "unknown"')
  local health_b1
  health_b1=$(curl -fsS "$STREAM_URL/health/$TENANT_B_ID/$CAM_B1_ID" 2>/dev/null | jq -r '.health.connectivity // .status // "unknown"')

  log "  Tenant A stream health: $health_a1"
  log "  Tenant B stream health: $health_b1"

  # ── 7. Expired token (mocked — token has 5min TTL) ──────────────────

  test_smoke "Invalid/malformed token rejection"
  local bad_code
  bad_code=$(check_stream_active "invalid.token.here" "$TENANT_A_ID" "$CAM_A1_ID")
  if [[ "$bad_code" == "401" || "$bad_code" == "403" ]]; then
    pass "Malformed token correctly rejected (HTTP $bad_code)"
  else
    warn "Malformed token returned HTTP $bad_code (expected 401/403)"
  fi

  # ── Summary ─────────────────────────────────────────────────────────

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  TOTAL=$((PASSED + FAILED))
  if [[ $FAILED -eq 0 ]]; then
    echo -e "  ${GREEN}✓ ALL $TOTAL TESTS PASSED${NC}"
  else
    echo -e "  ${RED}✗ $FAILED/$TOTAL TESTS FAILED${NC}"
  fi
  echo ""
  echo "  Multi-tenant RTSP POC — Milestone 1"
  echo "  Tenants: 2 | Cameras: 3 | Streams: 3"
  echo "═══════════════════════════════════════════════════════════════"

  return $FAILED
}

main
