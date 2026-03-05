#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-lan}"
CMD="${2:-full}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_SCRIPT="$ROOT_DIR/scripts/pilot/virtual-harness.sh"
LAN_ENV="$ROOT_DIR/infra/.env.pilot.cameras"

run_mock() {
  PILOT_ENV_FILE=/dev/null \
  PILOT_CAM1_NAME=PILOT_MOCK_CAM_1 \
  PILOT_CAM2_NAME=PILOT_MOCK_CAM_2 \
  PILOT_CAM1_RTSP=rtsp://demo/pilot-mock-cam-1 \
  PILOT_CAM2_RTSP=rtsp://demo/pilot-mock-cam-2 \
  bash "$HARNESS_SCRIPT" "$CMD"
}

run_lan() {
  if [[ ! -f "$LAN_ENV" ]]; then
    echo "Missing $LAN_ENV. Copy from infra/.env.pilot.cameras.example and set your RTSP URLs." >&2
    exit 1
  fi
  PILOT_ENV_FILE="$LAN_ENV" bash "$HARNESS_SCRIPT" "$CMD"
}

case "$MODE" in
  mock)
    run_mock
    ;;
  lan)
    run_lan
    ;;
  *)
    echo "Usage: $0 <mock|lan> [prepare|run|cleanup|full]" >&2
    exit 1
    ;;
esac
