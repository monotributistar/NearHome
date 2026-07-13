#!/usr/bin/env bash
set -euo pipefail

CAMERA_IPS_CSV="${CAMERA_IPS:-}"
RTSP_PORT="${RTSP_PORT:-554}"
RTSP_PATH="${RTSP_PATH:-}"
RTSP_USER="${RTSP_USER:-}"
RTSP_PASSWORD="${RTSP_PASSWORD:-}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-5}"
STREAM_PROBE_TIMEOUT_US="${STREAM_PROBE_TIMEOUT_US:-15000000}"

if [[ -z "$CAMERA_IPS_CSV" ]]; then
  echo "Usage: CAMERA_IPS=\"192.168.10.101,192.168.10.102\" [RTSP_PATH=/stream1] [RTSP_USER=...] [RTSP_PASSWORD=...] $0" >&2
  exit 1
fi

IFS=',' read -r -a CAMERA_IPS <<< "$CAMERA_IPS_CSV"

have_ffprobe=0
if command -v ffprobe >/dev/null 2>&1; then
  have_ffprobe=1
fi

success_tcp=0
success_stream=0
total=0

for raw_ip in "${CAMERA_IPS[@]}"; do
  ip="$(echo "$raw_ip" | xargs)"
  [[ -n "$ip" ]] || continue
  total=$((total + 1))

  echo "== Camera ${ip} =="
  if nc -z -w "$CONNECT_TIMEOUT" "$ip" "$RTSP_PORT"; then
    echo "TCP connect: OK (${ip}:${RTSP_PORT})"
    success_tcp=$((success_tcp + 1))
  else
    echo "TCP connect: FAIL (${ip}:${RTSP_PORT})"
    continue
  fi

  auth_prefix=""
  if [[ -n "$RTSP_USER" ]]; then
    auth_prefix="$RTSP_USER"
    if [[ -n "$RTSP_PASSWORD" ]]; then
      auth_prefix+=":${RTSP_PASSWORD}"
    fi
    auth_prefix+="@"
  fi

  rtsp_url="rtsp://${auth_prefix}${ip}:${RTSP_PORT}${RTSP_PATH}"
  echo "RTSP URL: ${rtsp_url}"

  if [[ "$have_ffprobe" -eq 1 ]]; then
    if ffprobe -v error -rtsp_transport tcp -rw_timeout "$STREAM_PROBE_TIMEOUT_US" -show_streams "$rtsp_url" >/dev/null 2>&1; then
      echo "Stream probe: OK"
      success_stream=$((success_stream + 1))
    else
      echo "Stream probe: FAIL"
    fi
  else
    echo "Stream probe: SKIP (ffprobe not found)"
  fi
  echo

done

echo "Summary"
echo "- Cameras total: ${total}"
echo "- TCP success: ${success_tcp}/${total}"
if [[ "$have_ffprobe" -eq 1 ]]; then
  echo "- Stream success: ${success_stream}/${total}"
fi

if [[ "$success_tcp" -lt "$total" ]]; then
  exit 1
fi
