#!/usr/bin/env bash
set -euo pipefail

CMD="${1:-full}"
ENV_FILE="${PILOT_ENV_FILE:-infra/.env.pilot.cameras}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

API_URL="${API_URL:-http://localhost:3001}"
EVENT_URL="${EVENT_URL:-http://localhost:3011}"
BRIDGE_URL="${BRIDGE_URL:-http://localhost:8090}"
YOLO_URL="${YOLO_URL:-http://inference-node-yolo:8091}"
MEDIAPIPE_URL="${MEDIAPIPE_URL:-http://inference-node-mediapipe:8092}"

PILOT_EMAIL="${PILOT_EMAIL:-admin@nearhome.dev}"
PILOT_PASSWORD="${PILOT_PASSWORD:-demo1234}"
TENANT_ID_OVERRIDE="${PILOT_TENANT_ID:-}"

CAM1_NAME="${PILOT_CAM1_NAME:-PILOT_VIRTUAL_CAM_1}"
CAM2_NAME="${PILOT_CAM2_NAME:-PILOT_VIRTUAL_CAM_2}"
CAM1_RTSP="${PILOT_CAM1_RTSP:-rtsp://demo/pilot-virtual-cam-1}"
CAM2_RTSP="${PILOT_CAM2_RTSP:-rtsp://demo/pilot-virtual-cam-2}"

JOB_TIMEOUT_S="${PILOT_JOB_TIMEOUT_S:-90}"
POLL_S="${PILOT_JOB_POLL_S:-3}"

STATE_FILE="${PILOT_STATE_FILE:-/tmp/nearhome-pilot-virtual-state.json}"

TOKEN=""
TENANT_ID=""

require_tools() {
  command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
  command -v jq >/dev/null 2>&1 || { echo "jq is required"; exit 1; }
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$TENANT_ID" ]]; then
    if [[ -n "$body" ]]; then
      curl -fsS -X "$method" "$API_URL$path" \
        -H "Authorization: Bearer $TOKEN" \
        -H "X-Tenant-Id: $TENANT_ID" \
        -H "content-type: application/json" \
        -d "$body"
    else
      curl -fsS -X "$method" "$API_URL$path" \
        -H "Authorization: Bearer $TOKEN" \
        -H "X-Tenant-Id: $TENANT_ID"
    fi
  else
    if [[ -n "$body" ]]; then
      curl -fsS -X "$method" "$API_URL$path" \
        -H "Authorization: Bearer $TOKEN" \
        -H "content-type: application/json" \
        -d "$body"
    else
      curl -fsS -X "$method" "$API_URL$path" \
        -H "Authorization: Bearer $TOKEN"
    fi
  fi
}

login() {
  local payload
  payload="$(jq -nc --arg email "$PILOT_EMAIL" --arg password "$PILOT_PASSWORD" '{email:$email,password:$password}')"
  TOKEN="$(curl -fsS -X POST "$API_URL/auth/login" -H 'content-type: application/json' -d "$payload" | jq -r '.accessToken')"
  if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
    echo "login failed: no access token"
    exit 1
  fi
}

resolve_tenant() {
  if [[ -n "$TENANT_ID_OVERRIDE" ]]; then
    TENANT_ID="$TENANT_ID_OVERRIDE"
    return
  fi
  TENANT_ID="$(api GET "/tenants" | jq -r '.data[0].id')"
  if [[ -z "$TENANT_ID" || "$TENANT_ID" == "null" ]]; then
    echo "no tenant found for user $PILOT_EMAIL"
    exit 1
  fi
}

register_nodes() {
  local yolo_payload mediapipe_payload
  yolo_payload="$(jq -nc --arg endpoint "$YOLO_URL" \
    '{nodeId:"pilot-yolo-node",runtime:"python",transport:"http",endpoint:$endpoint,status:"online",maxConcurrent:4,queueDepth:0,isDrained:false,models:["yolo-v8"],capabilities:[{capabilityId:"det-objects",taskTypes:["object_detection"],models:["yolo-v8"]}]}' )"
  mediapipe_payload="$(jq -nc --arg endpoint "$MEDIAPIPE_URL" \
    '{nodeId:"pilot-mediapipe-node",runtime:"python",transport:"http",endpoint:$endpoint,status:"online",maxConcurrent:4,queueDepth:0,isDrained:false,models:["mediapipe-actions"],capabilities:[{capabilityId:"det-actions",taskTypes:["action_detection"],models:["mediapipe-actions"]}]}' )"

  curl -fsS -X POST "$BRIDGE_URL/v1/nodes/register" -H 'content-type: application/json' -d "$yolo_payload" >/tmp/pilot_node_yolo.json
  curl -fsS -X POST "$BRIDGE_URL/v1/nodes/register" -H 'content-type: application/json' -d "$mediapipe_payload" >/tmp/pilot_node_mediapipe.json
}

ensure_camera() {
  local camera_name="$1"
  local rtsp_url="$2"
  local existing
  existing="$(api GET "/cameras" | jq -r --arg n "$camera_name" '.data[] | select(.name == $n) | .id' | head -n 1 || true)"
  if [[ -n "$existing" ]]; then
    echo "$existing"
    return
  fi
  local payload
  payload="$(jq -nc --arg name "$camera_name" --arg rtsp "$rtsp_url" \
    '{name:$name,description:"pilot harness camera",rtspUrl:$rtsp,location:"pilot-lab",tags:["pilot","harness"],isActive:true}')"
  api POST "/cameras" "$payload" | jq -r '.data.id'
}

write_state() {
  local cam1_id="$1"
  local cam2_id="$2"
  jq -nc \
    --arg tenantId "$TENANT_ID" \
    --arg cam1Id "$cam1_id" \
    --arg cam2Id "$cam2_id" \
    --arg cam1Name "$CAM1_NAME" \
    --arg cam2Name "$CAM2_NAME" \
    '{tenantId:$tenantId,cam1:{id:$cam1Id,name:$cam1Name},cam2:{id:$cam2Id,name:$cam2Name}}' >"$STATE_FILE"
}

read_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "missing state file $STATE_FILE"
    exit 1
  fi
}

create_detection_job() {
  local camera_id="$1"
  local payload
  payload="$(jq -nc --arg cameraId "$camera_id" '{cameraId:$cameraId,mode:"realtime",source:"snapshot",provider:"onprem_bento",options:{taskType:"object_detection",modelRef:"yolo-v8",deadlineMs:15000,priority:5}}')"
  api POST "/detections/jobs" "$payload" | jq -r '.data.id'
}

wait_job() {
  local job_id="$1"
  local deadline=$((SECONDS + JOB_TIMEOUT_S))
  while ((SECONDS < deadline)); do
    local status
    status="$(api GET "/detections/jobs/$job_id" | jq -r '.data.status')"
    if [[ "$status" == "succeeded" ]]; then
      echo "succeeded"
      return
    fi
    if [[ "$status" == "failed" || "$status" == "canceled" ]]; then
      echo "$status"
      return
    fi
    sleep "$POLL_S"
  done
  echo "timeout"
}

prepare() {
  require_tools
  login
  resolve_tenant
  register_nodes
  local cam1_id cam2_id
  cam1_id="$(ensure_camera "$CAM1_NAME" "$CAM1_RTSP")"
  cam2_id="$(ensure_camera "$CAM2_NAME" "$CAM2_RTSP")"
  write_state "$cam1_id" "$cam2_id"
  echo "Prepared tenant=$TENANT_ID cam1=$cam1_id cam2=$cam2_id"
}

run_jobs() {
  require_tools
  login
  if [[ -n "$TENANT_ID_OVERRIDE" ]]; then
    TENANT_ID="$TENANT_ID_OVERRIDE"
  else
    read_state
    TENANT_ID="$(jq -r '.tenantId' "$STATE_FILE")"
  fi
  read_state
  local cam1_id cam2_id
  cam1_id="$(jq -r '.cam1.id' "$STATE_FILE")"
  cam2_id="$(jq -r '.cam2.id' "$STATE_FILE")"

  local job1 job2
  job1="$(create_detection_job "$cam1_id")"
  job2="$(create_detection_job "$cam2_id")"
  echo "Started jobs: $job1 $job2"

  local s1 s2
  s1="$(wait_job "$job1")"
  s2="$(wait_job "$job2")"
  echo "Job status: $job1=$s1 $job2=$s2"
  if [[ "$s1" != "succeeded" || "$s2" != "succeeded" ]]; then
    echo "Detection harness failed"
    exit 1
  fi

  local r1 r2
  r1="$(api GET "/detections/jobs/$job1/results" | jq -r '.total')"
  r2="$(api GET "/detections/jobs/$job2/results" | jq -r '.total')"
  echo "Results count: $job1=$r1 $job2=$r2"

  curl -fsS "$EVENT_URL/events/stream?once=1&replay=50&topics=detection.job,incident" \
    -H "X-Tenant-Id: $TENANT_ID" >/tmp/pilot_harness_events.txt
  if ! rg -q "detection.job|incident" /tmp/pilot_harness_events.txt; then
    echo "No detection/incident events found in replay"
    exit 1
  fi

  echo "Pilot harness PASS"
}

cleanup() {
  require_tools
  login
  if [[ -n "$TENANT_ID_OVERRIDE" ]]; then
    TENANT_ID="$TENANT_ID_OVERRIDE"
  else
    TENANT_ID="$(api GET "/tenants" | jq -r '.data[0].id')"
  fi

  local id1 id2
  id1="$(api GET "/cameras" | jq -r --arg n "$CAM1_NAME" '.data[] | select(.name == $n) | .id' | head -n 1 || true)"
  id2="$(api GET "/cameras" | jq -r --arg n "$CAM2_NAME" '.data[] | select(.name == $n) | .id' | head -n 1 || true)"
  if [[ -n "$id1" ]]; then
    api DELETE "/cameras/$id1" >/tmp/pilot_cleanup_cam1.json
  fi
  if [[ -n "$id2" ]]; then
    api DELETE "/cameras/$id2" >/tmp/pilot_cleanup_cam2.json
  fi
  rm -f "$STATE_FILE"
  echo "Cleanup done"
}

case "$CMD" in
  prepare)
    prepare
    ;;
  run)
    run_jobs
    ;;
  cleanup)
    cleanup
    ;;
  full)
    prepare
    run_jobs
    ;;
  *)
    echo "Usage: $0 {prepare|run|cleanup|full}" >&2
    exit 1
    ;;
esac
