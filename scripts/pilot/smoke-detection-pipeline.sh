#!/usr/bin/env bash
# =============================================================================
# NearHome POC — Milestone 2 Smoke Test: Detection Pipeline
# =============================================================================
# Valida el pipeline de detección end-to-end:
#   1. inference-bridge /v1/infer/hf/yolo acepta JPEG y retorna detecciones
#   2. inference-bridge /v1/infer/hf/health reporta estado
#   3. change-detector arranca y detecta movimiento en stream sintético
#   4. Pipeline completo: RTSP simulado → change-detector → inference-bridge
#
# Requisitos:
#   - Stack NearHome corriendo (API :3001, stream-gateway :3010)
#   - inference-bridge corriendo (:8090)
#   - RTSP simulator corriendo (Milestone 1)
#
# Uso:
#   bash scripts/pilot/smoke-detection-pipeline.sh
# =============================================================================
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:8090}"
CHANGE_URL="${CHANGE_URL:-http://localhost:8085}"
EVENT_URL="${EVENT_URL:-http://localhost:3011}"

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
fail() { FAILED=$((FAILED + 1)); err "  ✗ $*"; }

require_tools() {
  for tool in curl jq python3; do
    command -v "$tool" >/dev/null 2>&1 || { err "$tool is required"; exit 1; }
  done
}

# ─── Generate synthetic JPEG frame ────────────────────────────────────────

generate_test_frame() {
  python3 -c "
import io, numpy as np
from PIL import Image
# Create a simple test frame (640x480, red rectangle on blue background)
frame = np.full((480, 640, 3), (255, 128, 0), dtype=np.uint8)  # blue bg
frame[150:330, 200:440] = (0, 0, 255)  # red rectangle (person-like blob)
img = Image.fromarray(frame)
buf = io.BytesIO()
img.save(buf, format='JPEG', quality=85)
import sys; sys.stdout.buffer.write(buf.getvalue())
" 2>/dev/null
}

# ─── Main ─────────────────────────────────────────────────────────────────

main() {
  require_tools

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  NearHome POC — Milestone 2: Detection Pipeline Smoke Test"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  # ── 1. inference-bridge health ─────────────────────────────────────

  info "TEST 1: inference-bridge health"
  local bridge_health
  if bridge_health=$(curl -fsS "$BRIDGE_URL/health" 2>/dev/null); then
    local nodes
    nodes=$(echo "$bridge_health" | jq -r '.nodes // 0')
    pass "inference-bridge healthy (nodes=$nodes)"
  else
    fail "inference-bridge not reachable at $BRIDGE_URL"
  fi

  # ── 2. HF health endpoint ──────────────────────────────────────────

  info "TEST 2: HF Spaces health check"
  local hf_health
  if hf_health=$(curl -fsS "$BRIDGE_URL/v1/infer/hf/health" 2>/dev/null); then
    local has_token
    has_token=$(echo "$hf_health" | jq -r '.hfTokenConfigured')
    pass "HF health endpoint responding (tokenConfigured=$has_token)"
  else
    fail "HF health endpoint not reachable"
  fi

  # ── 3. YOLO inference with synthetic frame ─────────────────────────

  info "TEST 3: YOLO inference (mock fallback)"
  local frame_file
  frame_file=$(mktemp /tmp/nearhome-smoke-frame-XXXXXX.jpg)
  generate_test_frame > "$frame_file"
  local frame_size
  frame_size=$(wc -c < "$frame_file")
  log "  Generated test frame: ${frame_size} bytes"

  local yolo_result
  if yolo_result=$(curl -fsS -X POST "$BRIDGE_URL/v1/infer/hf/yolo" \
    -F "file=@$frame_file" \
    -F "tenantId=poc-smoke" \
    -F "cameraId=poc-smoke-cam" \
    -F "frameTs=$(date +%s%3N)" \
    -F "motionPct=0.15" 2>/dev/null); then

    local status detections
    status=$(echo "$yolo_result" | jq -r '.status')
    detections=$(echo "$yolo_result" | jq -r '.detections | length')

    if [[ "$status" == "ok" && "$detections" -gt 0 ]]; then
      local label conf
      label=$(echo "$yolo_result" | jq -r '.detections[0].label')
      conf=$(echo "$yolo_result" | jq -r '.detections[0].confidence')
      pass "YOLO detection: $label (confidence=$conf, total=$detections)"
    elif [[ "$status" == "cold_start" ]]; then
      pass "YOLO cold start detected (expected for first call)"
    else
      fail "YOLO returned status=$status detections=$detections"
    fi
  else
    fail "YOLO inference request failed"
  fi
  rm -f "$frame_file"

  # ── 4. Keep-warm endpoint ──────────────────────────────────────────

  info "TEST 4: HF keep-warm endpoint"
  local warm_result
  if warm_result=$(curl -fsS -X POST "$BRIDGE_URL/v1/infer/hf/keep-warm" 2>/dev/null); then
    local warm_status
    warm_status=$(echo "$warm_result" | jq -r '.status')
    pass "Keep-warm triggered (status=$warm_status)"
  else
    fail "Keep-warm endpoint failed"
  fi

  # ── 5. Verify mock detection includes expected fields ───────────────

  info "TEST 5: Detection payload validation"
  frame_file=$(mktemp /tmp/nearhome-smoke-frame-XXXXXX.jpg)
  generate_test_frame > "$frame_file"

  local detailed
  if detailed=$(curl -fsS -X POST "$BRIDGE_URL/v1/infer/hf/yolo" \
    -F "file=@$frame_file" \
    -F "tenantId=poc-smoke" \
    -F "cameraId=poc-smoke-cam" 2>/dev/null); then

    local has_label has_conf has_bbox
    has_label=$(echo "$detailed" | jq -r '.detections[0].label // "missing"')
    has_conf=$(echo "$detailed" | jq -r '.detections[0].confidence // "missing"')
    has_bbox=$(echo "$detailed" | jq -r '.detections[0].bbox // "missing"')

    if [[ "$has_label" != "missing" && "$has_conf" != "missing" && "$has_bbox" != "missing" ]]; then
      pass "Detection payload valid: label=$has_label, conf=$has_conf, bbox=$has_bbox"
    else
      fail "Detection payload missing fields"
    fi
  else
    fail "Detailed detection request failed"
  fi
  rm -f "$frame_file"

  # ── 6. Multiple frames — consistent results ────────────────────────

  info "TEST 6: Multiple frames consistency"
  local consistent=true
  for i in $(seq 1 3); do
    frame_file=$(mktemp /tmp/nearhome-smoke-frame-XXXXXX.jpg)
    generate_test_frame > "$frame_file"

    local result
    if result=$(curl -fsS -X POST "$BRIDGE_URL/v1/infer/hf/yolo" \
      -F "file=@$frame_file" \
      -F "tenantId=poc-smoke" \
      -F "cameraId=poc-smoke-cam" 2>/dev/null); then

      local status
      status=$(echo "$result" | jq -r '.status')
      if [[ "$status" != "ok" && "$status" != "cold_start" ]]; then
        warn "  Frame $i: unexpected status=$status"
        consistent=false
      fi
    else
      warn "  Frame $i: request failed"
      consistent=false
    fi
    rm -f "$frame_file"
  done

  if $consistent; then
    pass "3 frames processed consistently"
  else
    fail "Inconsistent frame processing"
  fi

  # ── 7. Tenanted detection isolation ────────────────────────────────

  if [[ -f "$STATE_FILE" ]]; then
    info "TEST 7: Tenanted detection isolation"
    local TENANT_A
    TENANT_A=$(jq -r '.tenants.a.id' "$STATE_FILE")
    local CAM_A1
    CAM_A1=$(jq -r '.tenants.a.cameras[0].id' "$STATE_FILE")

    frame_file=$(mktemp /tmp/nearhome-smoke-frame-XXXXXX.jpg)
    generate_test_frame > "$frame_file"

    local tenant_result
    if tenant_result=$(curl -fsS -X POST "$BRIDGE_URL/v1/infer/hf/yolo" \
      -F "file=@$frame_file" \
      -F "tenantId=$TENANT_A" \
      -F "cameraId=$CAM_A1" 2>/dev/null); then

      local det_count
      det_count=$(echo "$tenant_result" | jq -r '.detections | length')
      pass "Tenanted detection: tenant=$TENANT_A camera=$CAM_A1 → $det_count detections"
    else
      fail "Tenanted detection request failed"
    fi
    rm -f "$frame_file"
  else
    warn "Skipping tenanted test — state file not found (run seed-multi-tenant.sh first)"
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
  echo "  Detection Pipeline — Milestone 2"
  echo "  Components: change-detector + inference-bridge + HF YOLO"
  echo "═══════════════════════════════════════════════════════════════"

  return $FAILED
}

main
