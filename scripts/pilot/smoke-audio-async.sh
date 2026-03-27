#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
EVENT_URL="${EVENT_URL:-http://localhost:3011}"
PILOT_EMAIL="${PILOT_EMAIL:-admin@nearhome.dev}"
PILOT_PASSWORD="${PILOT_PASSWORD:-demo1234}"
SMOKE_AUDIO_JOB_TIMEOUT_S="${SMOKE_AUDIO_JOB_TIMEOUT_S:-120}"
SMOKE_AUDIO_POLL_S="${SMOKE_AUDIO_POLL_S:-2}"
SMOKE_AUDIO_CAMERA_NAME="${SMOKE_AUDIO_CAMERA_NAME:-SMOKE_AUDIO_ASYNC_CAM}"
SMOKE_AUDIO_CAMERA_RTSP="${SMOKE_AUDIO_CAMERA_RTSP:-rtsp://demo/pilot-virtual-1}"

require_tools() {
  command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
  command -v jq >/dev/null 2>&1 || { echo "jq is required"; exit 1; }
  command -v rg >/dev/null 2>&1 || { echo "rg is required"; exit 1; }
}

auth_login() {
  local payload
  payload="$(jq -nc --arg email "$PILOT_EMAIL" --arg password "$PILOT_PASSWORD" '{email:$email,password:$password}')"
  TOKEN="$(curl -fsS -X POST "$API_URL/auth/login" -H 'content-type: application/json' -d "$payload" | jq -r '.accessToken')"
  if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
    echo "E2E audio smoke failed: login returned no token"
    exit 1
  fi
}

resolve_tenant() {
  TENANT_ID="$(curl -fsS "$API_URL/auth/me" -H "authorization: Bearer $TOKEN" | jq -r '.memberships[0].tenantId')"
  if [[ -z "$TENANT_ID" || "$TENANT_ID" == "null" ]]; then
    echo "E2E audio smoke failed: tenant not found"
    exit 1
  fi
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$API_URL$path" \
      -H "authorization: Bearer $TOKEN" \
      -H "x-tenant-id: $TENANT_ID" \
      -H 'content-type: application/json' \
      -d "$body"
  else
    curl -fsS -X "$method" "$API_URL$path" \
      -H "authorization: Bearer $TOKEN" \
      -H "x-tenant-id: $TENANT_ID"
  fi
}

ensure_camera() {
  local existing
  existing="$(api GET "/cameras?_start=0&_end=50" | jq -r --arg n "$SMOKE_AUDIO_CAMERA_NAME" '.data[]? | select(.name == $n) | .id' | head -n 1 || true)"
  if [[ -n "$existing" ]]; then
    CAMERA_ID="$existing"
    return
  fi

  local payload
  payload="$(jq -nc \
    --arg name "$SMOKE_AUDIO_CAMERA_NAME" \
    --arg rtsp "$SMOKE_AUDIO_CAMERA_RTSP" \
    '{name:$name,description:"audio async smoke camera",rtspUrl:$rtsp,location:"lab",tags:["smoke","audio"],isActive:true}')"
  CAMERA_ID="$(api POST "/cameras" "$payload" | jq -r '.data.id')"
  if [[ -z "$CAMERA_ID" || "$CAMERA_ID" == "null" ]]; then
    echo "E2E audio smoke failed: could not create camera"
    exit 1
  fi
}

create_audio_job() {
  local payload
  payload="$(jq -nc \
    --arg cameraId "$CAMERA_ID" \
    '{cameraId:$cameraId,mode:"realtime",source:"snapshot",provider:"onprem_bento",options:{taskType:"audio_event_classification",modelRef:"audio-mvp@0.1.0",mediaKind:"audio",minVolume:0.05,windowMs:500,overlapMs:250,sampleRate:16000,channels:1}}')"
  JOB_ID="$(api POST "/v1/detections/jobs" "$payload" | jq -r '.data.id')"
  if [[ -z "$JOB_ID" || "$JOB_ID" == "null" ]]; then
    echo "E2E audio smoke failed: could not create job"
    exit 1
  fi
}

wait_job() {
  local timeout="$SMOKE_AUDIO_JOB_TIMEOUT_S"
  local interval="$SMOKE_AUDIO_POLL_S"
  local waited=0
  STATUS="queued"

  while (( waited < timeout )); do
    JOB_JSON="$(api GET "/v1/detections/jobs/$JOB_ID")"
    STATUS="$(printf '%s' "$JOB_JSON" | jq -r '.data.status')"
    if [[ "$STATUS" == "succeeded" || "$STATUS" == "failed" || "$STATUS" == "canceled" ]]; then
      return
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done

  STATUS="timeout"
}

validate() {
  RESULTS_JSON="$(api GET "/v1/detections/jobs/$JOB_ID/results")"
  INCIDENTS_JSON="$(api GET "/v1/incidents?_start=0&_end=100")"
  EVENTS_RAW="$(curl -fsS "$EVENT_URL/events/stream?once=1&replay=200&topics=detection.job,incident" -H "X-Tenant-Id: $TENANT_ID")"

  local total_results audio_results audio_runner_results audio_incidents job_event_hits audio_event_hits run_id
  total_results="$(printf '%s' "$RESULTS_JSON" | jq -r '.total // 0')"
  audio_results="$(printf '%s' "$RESULTS_JSON" | jq -r '[.data[]? | select((.mediaKind // .attributes.mediaKind // "") == "audio")] | length')"
  audio_runner_results="$(printf '%s' "$RESULTS_JSON" | jq -r '[.data[]? | select((.providerMeta.provider // "") == "audio_runner")] | length')"
  audio_incidents="$(printf '%s' "$INCIDENTS_JSON" | jq -r --arg cameraId "$CAMERA_ID" '[.data[]? | select(.cameraId == $cameraId and ((.type // "") | startswith("audio_event_")))] | length')"
  job_event_hits="$(printf '%s' "$EVENTS_RAW" | rg -c "$JOB_ID" || true)"
  audio_event_hits="$(printf '%s' "$EVENTS_RAW" | rg -c 'audio_event_|audio_detected\\.' || true)"
  run_id="$(printf '%s' "$JOB_JSON" | jq -r '.data.runId // ""')"

  echo "E2E_ASYNC_AUDIO_SUMMARY job=$JOB_ID status=$STATUS run_id=${run_id:-none} total_results=$total_results audio_results=$audio_results audio_runner_results=$audio_runner_results audio_incidents=$audio_incidents event_job_hits=$job_event_hits event_audio_hits=$audio_event_hits"

  if [[ "$STATUS" != "succeeded" ]]; then
    echo "E2E audio smoke failed: job status=$STATUS"
    exit 1
  fi
  if [[ -z "$run_id" || "$run_id" == "null" ]]; then
    echo "E2E audio smoke failed: runId missing (expected async temporal dispatch)"
    exit 1
  fi
  if [[ "$total_results" -lt 1 ]]; then
    echo "E2E audio smoke failed: results are empty"
    exit 1
  fi
  if [[ "$audio_results" -lt 1 ]]; then
    echo "E2E audio smoke failed: no audio media results"
    exit 1
  fi
  if [[ "$audio_runner_results" -lt 1 ]]; then
    echo "E2E audio smoke failed: no audio_runner provider results"
    exit 1
  fi
  if [[ "$audio_incidents" -lt 1 ]]; then
    echo "E2E audio smoke failed: no audio incidents"
    exit 1
  fi
  if [[ "$job_event_hits" -lt 1 ]]; then
    echo "E2E audio smoke failed: no job event found in event replay"
    exit 1
  fi
  if [[ "$audio_event_hits" -lt 1 ]]; then
    echo "E2E audio smoke failed: no audio event found in event replay"
    exit 1
  fi
}

main() {
  require_tools
  auth_login
  resolve_tenant
  ensure_camera
  create_audio_job
  wait_job
  validate
  echo "E2E_ASYNC_AUDIO_PASS"
}

TOKEN=""
TENANT_ID=""
CAMERA_ID=""
JOB_ID=""
STATUS=""
JOB_JSON=""
RESULTS_JSON=""
INCIDENTS_JSON=""
EVENTS_RAW=""

main "$@"
