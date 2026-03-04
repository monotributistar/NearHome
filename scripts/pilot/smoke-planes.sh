#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
STREAM_URL="${STREAM_URL:-http://localhost:3010}"
EVENT_URL="${EVENT_URL:-http://localhost:3011}"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:8090}"
YOLO_URL="${YOLO_URL:-http://localhost:8091}"
MEDIAPIPE_URL="${MEDIAPIPE_URL:-http://localhost:8092}"
DISPATCHER_URL="${DISPATCHER_URL:-http://localhost:8072}"
TEMPORAL_UI_URL="${TEMPORAL_UI_URL:-http://localhost:8088}"
EVENT_PUBLISH_SECRET="${EVENT_PUBLISH_SECRET:-dev-event-publish-secret}"

TENANT_ID="${SMOKE_TENANT_ID:-tenant-a}"
CAM1="${SMOKE_CAMERA_1:-pilot-virtual-1}"
CAM2="${SMOKE_CAMERA_2:-pilot-virtual-2}"

check_health() {
  local name="$1"
  local url="$2"
  echo "Checking $name -> $url"
  curl -fsS "$url" >/tmp/"$name".json
}

echo "== Control plane =="
check_health api "$API_URL/health"

echo "== Data plane =="
check_health stream "$STREAM_URL/health"

curl -fsS -X POST "$STREAM_URL/provision" \
  -H 'content-type: application/json' \
  -d "{\"tenantId\":\"$TENANT_ID\",\"cameraId\":\"$CAM1\",\"rtspUrl\":\"rtsp://demo/$CAM1\"}" >/tmp/provision_cam1.json
curl -fsS -X POST "$STREAM_URL/provision" \
  -H 'content-type: application/json' \
  -d "{\"tenantId\":\"$TENANT_ID\",\"cameraId\":\"$CAM2\",\"rtspUrl\":\"rtsp://demo/$CAM2\"}" >/tmp/provision_cam2.json

check_health stream_cam1 "$STREAM_URL/health/$TENANT_ID/$CAM1"
check_health stream_cam2 "$STREAM_URL/health/$TENANT_ID/$CAM2"
curl -fsS "$STREAM_URL/metrics" | rg -q 'nearhome_streams_total{status="ready"}'

echo "== Event plane =="
check_health event "$EVENT_URL/health"
curl -fsS -X POST "$EVENT_URL/internal/events/publish" \
  -H "x-event-publish-secret: $EVENT_PUBLISH_SECRET" \
  -H 'content-type: application/json' \
  -d "{\"eventType\":\"incident.created\",\"tenantId\":\"$TENANT_ID\",\"payload\":{\"source\":\"smoke\"}}" >/tmp/event_publish.json
curl -fsS "$EVENT_URL/events/stream?once=1&replay=5&topics=incident" -H "X-Tenant-Id: $TENANT_ID" >/tmp/event_replay.txt
rg -q "incident.created" /tmp/event_replay.txt

echo "== Detection plane =="
check_health bridge "$BRIDGE_URL/health"
check_health yolo "$YOLO_URL/health"
check_health mediapipe "$MEDIAPIPE_URL/health"
check_health dispatcher "$DISPATCHER_URL/health"
curl -fsS "$TEMPORAL_UI_URL" >/tmp/temporal_ui.html

echo "Smoke planes PASS"
