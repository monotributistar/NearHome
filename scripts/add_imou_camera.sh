#!/bin/bash

SHINOBI_URL="http://localhost:8080"
EMAIL="admin@shinobi.video"
PASS="admin"

CAMERA_ID="imou-entrada"
CAMERA_NAME="Camara Entrada Imou"
CAMERA_HOST="192.168.0.161"
CAMERA_USER="admin"
CAMERA_PASS="L2EA8499"
CAMERA_PATH="/cam/realmonitor?channel=1&subtype=1"

echo "=== Autenticando en Shinobi ==="
AUTH_RESPONSE=$(curl -s -X POST "${SHINOBI_URL}?json=true" \
  -H "Content-Type: application/json" \
  -d "{\"mail\":\"${EMAIL}\",\"pass\":\"${PASS}\"}")

echo "Respuesta: $AUTH_RESPONSE"

API_KEY=$(echo $AUTH_RESPONSE | grep -o '"auth_token":"[^"]*' | sed 's/"auth_token":"//')
GROUP_KEY=$(echo $AUTH_RESPONSE | grep -o '"group_key":"[^"]*' | sed 's/"group_key":"//')

echo "API Key: $API_KEY"
echo "Group Key: $GROUP_KEY"

if [ -z "$API_KEY" ]; then
  echo "Error: No se pudo obtener API Key"
  exit 1
fi

echo ""
echo "=== Agregando cámara ==="

DATA=$(cat <<EOF
{
  "mode": "start",
  "mid": "${CAMERA_ID}",
  "name": "${CAMERA_NAME}",
  "type": "h264",
  "protocol": "rtsp",
  "host": "${CAMERA_HOST}",
  "port": "554",
  "path": "${CAMERA_PATH}",
  "fps": "10",
  "details": {
    "auto_host_enable": "1",
    "auto_host": "rtsp://${CAMERA_USER}:${CAMERA_PASS}@${CAMERA_HOST}:554${CAMERA_PATH}",
    "rtsp_transport": "tcp",
    "muser": "${CAMERA_USER}",
    "mpass": "${CAMERA_PASS}",
    "stream_type": "mp4",
    "stream_vcodec": "copy",
    "stream_acodec": "no",
    "detector": "1",
    "detector_use_motion": "1"
  }
}
EOF
)

curl -X POST "${SHINOBI_URL}/${API_KEY}/configureMonitor/${GROUP_KEY}/${CAMERA_ID}?data=${DATA}" \
  -H "Content-Type: application/json"

echo ""
echo "=== Cámara agregada. Verificando... ==="

curl -s "${SHINOBI_URL}/${API_KEY}/monitor/${GROUP_KEY}" | python -m json.tool

echo ""
echo "Listo! Accede a http://localhost:8080 para ver tu cámara"
