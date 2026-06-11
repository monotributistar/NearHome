#!/usr/bin/env bash
# =============================================================================
# NearHome POC — RTSP Simulator (Multi-Tenant Test Streams)
# =============================================================================
set -euo pipefail

RTSP_PORT="${RTSP_PORT:-8554}"
RTSP_HOST="${RTSP_HOST:-localhost}"

# Simulated streams: path|label|width|height|mode
STREAMS=(
  "alpha-entrada|Main Entrance|1280|720|motion"
  "alpha-patio|Backyard|640|480|static"
  "bravo-pasillo|Hallway|640|480|motion"
)

PID_DIR="${PID_DIR:-/tmp/nearhome-rtsp-sim}"
LOG_DIR="${LOG_DIR:-/tmp/nearhome-rtsp-sim}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[rtsp-sim]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── MediaMTX management ──────────────────────────────────────────────────

check_mediamtx() {
  # RTSP server responds HTTP 400 on root path — that's expected
  curl -s -o /dev/null "http://$RTSP_HOST:$RTSP_PORT" 2>/dev/null
  return 0
}

start_mediamtx() {
  log "Checking MediaMTX on :$RTSP_PORT..."
  if curl -s -o /dev/null --max-time 2 "http://$RTSP_HOST:$RTSP_PORT" 2>/dev/null; then
    log "MediaMTX already running"
    return 0
  fi

  # Docker
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    # Remove old container if exists
    docker rm -f nearhome-rtsp-sim-server 2>/dev/null || true
    log "Starting MediaMTX via Docker..."
    docker run -d --rm --name nearhome-rtsp-sim-server \
      -p "$RTSP_PORT:8554" \
      -p "1935:1935" \
      -p "8888:8888" \
      -p "8889:8889" \
      -p "8890:8890" \
      bluenviron/mediamtx:latest \
      >/dev/null 2>&1
    sleep 3
    if curl -s -o /dev/null --max-time 2 "http://$RTSP_HOST:$RTSP_PORT" 2>/dev/null; then
      log "MediaMTX started via Docker"
      return 0
    fi
    warn "Docker MediaMTX didn't respond, trying local..."
    docker rm -f nearhome-rtsp-sim-server 2>/dev/null || true
  fi

  # Local binary
  if command -v mediamtx >/dev/null 2>&1; then
    log "Starting MediaMTX directly..."
    mkdir -p "$LOG_DIR"
    mediamtx >"$LOG_DIR/mediamtx.log" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_DIR/mediamtx.pid"
    sleep 3
    if curl -s -o /dev/null --max-time 2 "http://$RTSP_HOST:$RTSP_PORT" 2>/dev/null; then
      log "MediaMTX started (pid=$pid)"
      return 0
    fi
  fi

  err "Cannot start MediaMTX. Options: docker run bluenviron/mediamtx OR brew install bluenviron/tap/mediamtx"
}

# ─── Stream lifecycle ─────────────────────────────────────────────────────

start_stream() {
  local path="$1" label="$2" width="$3" height="$4" mode="$5"

  local rtsp_url="rtsp://$RTSP_HOST:$RTSP_PORT/$path"
  local pidfile="$PID_DIR/$path.pid"
  local logfile="$LOG_DIR/$path.log"

  mkdir -p "$PID_DIR" "$LOG_DIR"

  # Determine ffmpeg filter based on mode
  local filter_cmd=""
  case "$mode" in
    motion)
      filter_cmd="geq=r='X/W*r(1,2)':g='Y/H*r(1,2)':b='128+r(1,2)*127',"
      ;;
    static|*)
      filter_cmd=""
      ;;
  esac

  ffmpeg -re -f lavfi \
    -i "testsrc=size=${width}x${height}:rate=15" \
    -f lavfi -i "sine=frequency=440:duration=3600" \
    -vf "${filter_cmd}drawtext=text='${label} | ${path}':x=10:y=10:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.5" \
    -c:v libx264 -preset ultrafast -tune zerolatency \
    -pix_fmt yuv420p -g 30 -r 15 \
    -c:a aac -b:a 32k -ar 16000 -ac 1 \
    -f rtsp "$rtsp_url" \
    >"$logfile" 2>&1 &

  local pid=$!
  echo "$pid" > "$pidfile"
  sleep 1

  # Verify the stream PID is alive
  if kill -0 "$pid" 2>/dev/null; then
    log "  Started: $path ($label, ${width}x${height}, $mode) → $rtsp_url (pid=$pid)"
  else
    warn "  Started but PID dead: $path (check $logfile)"
  fi
}

stop_stream() {
  local path="$1"
  local pidfile="$PID_DIR/$path.pid"

  if [[ -f "$pidfile" ]]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      log "  Stopped: $path (pid=$pid)"
    else
      log "  $path (pid=$pid already dead)"
    fi
    rm -f "$pidfile"
  else
    log "  $path: no pid file found"
  fi
}

# ─── Commands ─────────────────────────────────────────────────────────────

cmd_start() {
  log "Starting RTSP simulator..."
  start_mediamtx

  log "Launching test streams..."
  for entry in "${STREAMS[@]}"; do
    local path label width height mode
    IFS='|' read -r path label width height mode <<< "$entry"
    start_stream "$path" "$label" "$width" "$height" "$mode"
  done

  echo ""
  log "All streams started. RTSP URLs:"
  for entry in "${STREAMS[@]}"; do
    local path
    IFS='|' read -r path _ <<< "$entry"
    echo "  rtsp://$RTSP_HOST:$RTSP_PORT/$path"
  done
  echo ""
  log "PIDs in: $PID_DIR"
  log "Logs in: $LOG_DIR"
}

cmd_stop() {
  log "Stopping RTSP simulator..."
  for entry in "${STREAMS[@]}"; do
    local path
    IFS='|' read -r path _ <<< "$entry"
    stop_stream "$path"
  done

  # Stop MediaMTX
  local pidfile="$PID_DIR/mediamtx.pid"
  if [[ -f "$pidfile" ]]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi
  docker rm -f nearhome-rtsp-sim-server 2>/dev/null || true

  log "All streams stopped"
}

cmd_status() {
  log "RTSP Simulator Status:"
  echo ""
  printf "  %-20s %-8s %s\n" "STREAM" "STATUS" "URL"
  printf "  %-20s %-8s %s\n" "──────" "──────" "───"

  for entry in "${STREAMS[@]}"; do
    local path
    IFS='|' read -r path _ <<< "$entry"
    local pidfile="$PID_DIR/$path.pid"
    local status="STOPPED"
    if [[ -f "$pidfile" ]]; then
      local pid
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        status="RUNNING"
      else
        status="DEAD"
      fi
    fi
    printf "  %-20s %-8s %s\n" "$path" "$status" "rtsp://$RTSP_HOST:$RTSP_PORT/$path"
  done

  echo ""
  if check_mediamtx; then
    log "MediaMTX: RUNNING on :$RTSP_PORT"
  else
    warn "MediaMTX: NOT RUNNING"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────

CMD="${1:-start}"
case "$CMD" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *)      echo "Usage: $0 {start|stop|status}" >&2; exit 1 ;;
esac
