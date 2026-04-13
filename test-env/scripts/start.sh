#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ENV_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$TEST_ENV_DIR")"

# Defaults
CAMERAS=3
BULBS=2
WITH_STACK=false
GENERATE=false

usage() {
  echo "Usage: $0 [--cameras N] [--bulbs M] [--with-stack] [--generate]"
  echo ""
  echo "Options:"
  echo "  --cameras N     Number of mock IP cameras (default: 3)"
  echo "  --bulbs M       Number of mock smart bulbs (default: 2)"
  echo "  --with-stack    Also start the main NearHome infra stack"
  echo "  --generate      Re-generate docker-compose with specified counts"
  echo ""
  echo "Examples:"
  echo "  $0                          # Start with default 3 cameras + 2 bulbs"
  echo "  $0 --cameras 5 --bulbs 4    # Start with 5 cameras + 4 bulbs"
  echo "  $0 --with-stack             # Start test env + main NearHome stack"
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --cameras) CAMERAS="$2"; GENERATE=true; shift 2 ;;
    --bulbs)   BULBS="$2";   GENERATE=true; shift 2 ;;
    --with-stack) WITH_STACK=true; shift ;;
    --generate)   GENERATE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

cd "$TEST_ENV_DIR"

echo "╔══════════════════════════════════════════════╗"
echo "║  NearHome Test Environment                   ║"
echo "║  Mock cameras: ${CAMERAS}  |  Mock bulbs: ${BULBS}        ║"
echo "╚══════════════════════════════════════════════╝"

# Load env file if present
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
fi

# Step 1: Optionally start the main NearHome stack
if [[ "$WITH_STACK" == "true" ]]; then
  echo ""
  echo "▶ Starting main NearHome stack..."
  docker compose -f "$PROJECT_ROOT/infra/docker-compose.yml" up -d --build
  echo "  Waiting for API to be ready..."
  for i in $(seq 1 30); do
    if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
      echo "  API is ready!"
      break
    fi
    sleep 2
  done
fi

# Step 2: Generate compose if custom counts or --generate flag
COMPOSE_FILE="docker-compose.yml"
if [[ "$GENERATE" == "true" ]]; then
  echo ""
  echo "▶ Generating compose with $CAMERAS cameras + $BULBS bulbs..."
  python3 scripts/generate-compose.py \
    --cameras "$CAMERAS" \
    --bulbs "$BULBS" \
    --output docker-compose.generated.yml
  COMPOSE_FILE="docker-compose.generated.yml"
fi

# Step 3: Build and start the test environment
echo ""
echo "▶ Building and starting test environment..."
docker compose -f "$COMPOSE_FILE" up -d --build

# Step 4: Wait for health checks
echo ""
echo "▶ Waiting for mock devices to be healthy..."
TIMEOUT=60
ELAPSED=0
while [[ $ELAPSED -lt $TIMEOUT ]]; do
  HEALTHY=$(docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null \
    | grep -c '"healthy"' || echo "0")
  TOTAL_CAMERAS=$CAMERAS
  # Cameras have healthchecks; bulbs + mosquitto may not report healthy the same way
  if [[ "$HEALTHY" -ge "$TOTAL_CAMERAS" ]]; then
    echo "  All mock cameras healthy!"
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [[ $ELAPSED -ge $TIMEOUT ]]; then
  echo "  ⚠ Timeout waiting for health checks. Checking status..."
fi

# Step 5: Show status
echo ""
echo "▶ Test environment status:"
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "═══════════════════════════════════════════════"
echo "  Test Environment Ready!"
echo ""
echo "  Mock cameras:"
for i in $(seq 1 "$CAMERAS"); do
  IP=$((9 + i))
  echo "    Camera $i: rtsp://172.30.0.${IP}/stream  |  ONVIF: http://172.30.0.${IP}:80"
done
echo ""
echo "  Mock bulbs:"
for i in $(seq 1 "$BULBS"); do
  IP=$((19 + i))
  echo "    Bulb $i: http://172.30.0.${IP}/state"
done
echo ""
echo "  Discovery Agent: scanning 172.30.0.0/24 every 10s"
echo "  MQTT Broker: mqtt://172.30.0.2:1883"
echo ""
echo "  Logs: docker compose -f $COMPOSE_FILE logs -f"
echo "  Stop: bash test-env/scripts/stop.sh"
echo "═══════════════════════════════════════════════"
