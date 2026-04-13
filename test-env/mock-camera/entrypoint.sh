#!/usr/bin/env bash
set -euo pipefail

echo "[mock-camera-${CAMERA_ID}] Starting mock IP camera"
echo "  Manufacturer: ${CAMERA_MANUFACTURER}"
echo "  Model:        ${CAMERA_MODEL}"
echo "  Serial:       ${CAMERA_SERIAL}"
echo "  RTSP:         :${RTSP_PORT}"
echo "  ONVIF:        :${ONVIF_PORT}"

# Update MediaMTX RTSP port if non-default
if [[ "${RTSP_PORT}" != "554" ]]; then
  sed -i "s/rtspAddress: :554/rtspAddress: :${RTSP_PORT}/" /app/mediamtx.yml
fi

# Start MediaMTX in background
mediamtx /app/mediamtx.yml &
MEDIAMTX_PID=$!
sleep 1

# Start FFmpeg test pattern generator pushing to local MediaMTX
ffmpeg -hide_banner -loglevel warning \
  -re -f lavfi \
  -i "smptehdbars=size=${STREAM_RESOLUTION}:rate=${STREAM_FPS}" \
  -f lavfi -i "sine=frequency=1000:sample_rate=8000" \
  -c:v libx264 -preset ultrafast -tune stillimage -g 30 -b:v 300k \
  -c:a aac -b:a 32k \
  -f rtsp -rtsp_transport tcp \
  "rtsp://localhost:${RTSP_PORT}/stream" &
FFMPEG_PID=$!

# Start ONVIF responder
python3 /app/onvif_responder.py &
ONVIF_PID=$!

echo "[mock-camera-${CAMERA_ID}] All processes started (mediamtx=$MEDIAMTX_PID ffmpeg=$FFMPEG_PID onvif=$ONVIF_PID)"

# Trap signals for graceful shutdown
cleanup() {
  echo "[mock-camera-${CAMERA_ID}] Shutting down..."
  kill "$FFMPEG_PID" "$ONVIF_PID" "$MEDIAMTX_PID" 2>/dev/null || true
  wait
}
trap cleanup SIGTERM SIGINT

# Wait for any process to exit
wait -n
EXIT_CODE=$?
echo "[mock-camera-${CAMERA_ID}] Process exited with code $EXIT_CODE, shutting down"
cleanup
exit "$EXIT_CODE"
