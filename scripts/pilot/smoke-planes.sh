#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
STREAM_URL="${STREAM_URL:-http://localhost:3010}"
EVENT_URL="${EVENT_URL:-http://localhost:3011}"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:8090}"
YOLO_URL="${YOLO_URL:-http://localhost:8091}"
MEDIAPIPE_URL="${MEDIAPIPE_URL:-http://localhost:8092}"
DISPATCHER_URL="${DISPATCHER_URL:-http://localhost:8072}"
AUDIORUNNER_URL="${AUDIORUNNER_URL:-http://localhost:8074}"
TEMPORAL_UI_URL="${TEMPORAL_UI_URL:-http://localhost:8088}"
EVENT_PUBLISH_SECRET="${EVENT_PUBLISH_SECRET:-dev-event-publish-secret}"
SMOKE_HEALTH_RETRIES="${SMOKE_HEALTH_RETRIES:-15}"
SMOKE_HEALTH_SLEEP_S="${SMOKE_HEALTH_SLEEP_S:-2}"

TENANT_ID="${SMOKE_TENANT_ID:-tenant-a}"
CAM1="${SMOKE_CAMERA_1:-pilot-virtual-1}"
CAM2="${SMOKE_CAMERA_2:-pilot-virtual-2}"

check_health() {
  local name="$1"
  local url="$2"
  echo "Checking $name -> $url"
  local attempt=1
  while true; do
    if curl -fsS "$url" >/tmp/"$name".json; then
      return 0
    fi
    if [[ "$attempt" -ge "$SMOKE_HEALTH_RETRIES" ]]; then
      echo "Health check failed for $name after $SMOKE_HEALTH_RETRIES attempts" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep "$SMOKE_HEALTH_SLEEP_S"
  done
}

check_health_optional() {
  local name="$1"
  local url="$2"
  if check_health "$name" "$url"; then
    return 0
  fi
  return 1
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
curl -fsS "$STREAM_URL/metrics" | rg -F -q 'nearhome_streams_total{status="ready"}'

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
if ! check_health_optional yolo "$YOLO_URL/health" || ! check_health_optional mediapipe "$MEDIAPIPE_URL/health"; then
  BRIDGE_NODES_JSON="$(curl -fsS "$BRIDGE_URL/v1/nodes")"
  ONLINE_NODE_COUNT="$(
    node -e '
      const body = JSON.parse(process.argv[1] || "{}");
      const rows = Array.isArray(body.data) ? body.data : [];
      const count = rows.filter((row) => row && (row.status === "online" || row.status === "degraded")).length;
      process.stdout.write(String(count));
    ' "$BRIDGE_NODES_JSON"
  )"
  if [[ "$ONLINE_NODE_COUNT" -gt 0 ]]; then
    echo "Static node health endpoints unavailable; continuing with generated detection nodes ($ONLINE_NODE_COUNT online)"
  else
    echo "No static node health and no generated online nodes in bridge" >&2
    exit 1
  fi
fi
check_health dispatcher "$DISPATCHER_URL/health"
check_health audio_runner "$AUDIORUNNER_URL/health"
curl -fsS "$TEMPORAL_UI_URL" >/tmp/temporal_ui.html

echo "Smoke planes PASS"
