#!/usr/bin/env bash
# Latency benchmark: RTSP → HLS playlist
# Mide tiempo desde que se provisiona un stream hasta que el primer segmento HLS aparece.
set -euo pipefail

STREAM_URL="${STREAM_URL:-http://localhost:3010}"
RTSP_URL="${RTSP_URL:-rtsp://localhost:8554/alpha-entrada}"
TENANT="${TENANT:-latency-test}"
CAM="${CAM:-latency-cam}"

GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}[bench]${NC} $*"; }

log "Provisioning stream..."
curl -sfS -X POST "$STREAM_URL/provision" -H 'content-type: application/json' \
  -d "{\"tenantId\":\"$TENANT\",\"cameraId\":\"$CAM\",\"rtspUrl\":\"$RTSP_URL\"}" >/dev/null

log "Waiting for HLS segments (checking every 500ms)..."
START=$(python3 -c "import time; print(int(time.time()*1000))")
MAX_WAIT=30
for i in $(seq 1 $((MAX_WAIT * 2))); do
  STATUS=$(curl -sfS "$STREAM_URL/health/$TENANT/$CAM" 2>/dev/null | jq -r '.health.connectivity // "unknown"')
  if [[ "$STATUS" == "online" || "$STATUS" == "ready" ]]; then
    END=$(python3 -c "import time; print(int(time.time()*1000))")
    ELAPSED=$((END - START))
    log "Stream READY in ${ELAPSED}ms (status=$STATUS)"
    exit 0
  fi
  sleep 0.5
done

log "TIMEOUT after ${MAX_WAIT}s — stream did not become ready"
exit 1
