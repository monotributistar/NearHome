#!/usr/bin/env bash
# =============================================================================
# NearHome POC — RTSP Simulator v3 (realistic CCTV videos on loop)
# =============================================================================
# Usa videos realistas estilo CCTV generados por generate-cctv-videos.py.
# Cada cámara virtual reproduce un video de cámara de seguridad en loop.
#
# Requisitos: ffmpeg, MediaMTX (Docker o local)
# Primero: python3 scripts/pilot/generate-cctv-videos.py
#
# Uso:
#   bash scripts/pilot/rtsp-simulator.sh start    # Inicia streams
#   bash scripts/pilot/rtsp-simulator.sh stop     # Detiene streams
#   bash scripts/pilot/rtsp-simulator.sh status   # Muestra estado
# =============================================================================
set -euo pipefail

RTSP_PORT="${RTSP_PORT:-8554}"
RTSP_HOST="${RTSP_HOST:-localhost}"
VIDEO_DIR="${VIDEO_DIR:-/tmp/nearhome-real-videos}"

# Virtual cameras: path → video_file → label
STREAMS=(
  "towncentre|TownCentreXVID.mp4|Oxford Town Centre — Calle peatones CCTV"
  "mall-interior|mall-interior.mp4|Centro Comercial — Pasillos, tiendas"
  "pets-campus|pets-campus.mp4|Campus Universitario — Edificios, entradas"
  "entrance-corridor|EnterExitCrossingPaths1cor.mp4|Puerta Entrada — Pasillo (CAVIAR)"
  "entrance-frontal|EnterExitCrossingPaths2front.mp4|Puerta Entrada — Vista Frontal (CAVIAR)"
  "browse-tienda|Browse1.mp4|Tienda — Personas navegando (CAVIAR)"
  "browse-tienda2|Browse3.mp4|Tienda 2 — Personas caminando (CAVIAR)"
)

PID_DIR="${PID_DIR:-/tmp/nearhome-rtsp-sim}"
LOG_DIR="${LOG_DIR:-/tmp/nearhome-rtsp-sim}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[rtsp]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[warn]${NC} $*" >&2; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ─── MediaMTX ──────────────────────────────────────────────────────────

check_mediamtx() {
  curl -s -o /dev/null --max-time 2 "http://$RTSP_HOST:$RTSP_PORT" 2>/dev/null
}

start_mediamtx() {
  log "Checking MediaMTX on :$RTSP_PORT..."
  if check_mediamtx; then
    log "MediaMTX already running"
    return 0
  fi

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker rm -f nearhome-rtsp-sim 2>/dev/null || true
    log "Starting MediaMTX via Docker..."
    docker run -d --rm --name nearhome-rtsp-sim \
      -p "$RTSP_PORT:8554" \
      bluenviron/mediamtx:latest >/dev/null 2>&1
    sleep 3
    if check_mediamtx; then
      log "MediaMTX started via Docker"
      return 0
    fi
    docker rm -f nearhome-rtsp-sim 2>/dev/null || true
  fi

  err "Cannot start MediaMTX. Install: docker run bluenviron/mediamtx:latest"
}

# ─── Stream lifecycle ──────────────────────────────────────────────────

start_stream() {
  local path="$1" video_file="$2" label="$3"

  local video_path="$VIDEO_DIR/$video_file"
  if [[ ! -f "$video_path" ]]; then
    warn "Video not found: $video_path — run generate-cctv-videos.py first"
    return 1
  fi

  local rtsp_url="rtsp://$RTSP_HOST:$RTSP_PORT/$path"
  local pidfile="$PID_DIR/$path.pid"
  local logfile="$LOG_DIR/$path.log"

  mkdir -p "$PID_DIR" "$LOG_DIR"

  # Loop video infinitely with H.264 re-encode for RTSP compatibility
  ffmpeg -re -stream_loop -1 -i "$video_path" \
    -c:v libx264 -preset ultrafast -tune zerolatency \
    -pix_fmt yuv420p -g 30 -r 15 \
    -an \
    -rtsp_transport tcp \
    -f rtsp "$rtsp_url" \
    >"$logfile" 2>&1 &

  local pid=$!
  echo "$pid" > "$pidfile"
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    log "  Started: $path ← $video_file ($label) → $rtsp_url (pid=$pid)"
  else
    warn "  PID dead: $path (check $logfile)"
  fi
}

stop_stream() {
  local path="$1"
  local pidfile="$PID_DIR/$path.pid"
  if [[ -f "$pidfile" ]]; then
    local pid=$(cat "$pidfile")
    kill "$pid" 2>/dev/null || true
    log "  Stopped: $path (pid=$pid)"
    rm -f "$pidfile"
  fi
}

# ─── Commands ──────────────────────────────────────────────────────────

cmd_start() {
  if [[ ! -d "$VIDEO_DIR" ]]; then
    warn "Video directory not found: $VIDEO_DIR"
    warn "Run: python3 scripts/pilot/generate-cctv-videos.py"
    if ! command -v python3 >/dev/null 2>&1; then
      warn "Falling back to testsrc streams..."
      for entry in "${STREAMS[@]}"; do
        IFS='|' read -r path video label <<< "$entry"
        start_testsrc "$path" "$label"
      done
      return
    fi
  fi

  start_mediamtx

  log "Launching virtual cameras (video loop)..."
  local missing=0
  for entry in "${STREAMS[@]}"; do
    IFS='|' read -r path video label <<< "$entry"
    if ! start_stream "$path" "$video" "$label"; then
      missing=$((missing + 1))
    fi
  done

  echo ""
  log "Streams active:"
  for entry in "${STREAMS[@]}"; do
    IFS='|' read -r path video label <<< "$entry"
    echo "  rtsp://$RTSP_HOST:$RTSP_PORT/$path  ← $label"
  done

  if [[ $missing -gt 0 ]]; then
    warn "$missing streams skipped (missing videos — run generate-cctv-videos.py)"
  fi
}

cmd_stop() {
  log "Stopping RTSP simulator..."
  for entry in "${STREAMS[@]}"; do
    IFS='|' read -r path video label <<< "$entry"
    stop_stream "$path"
  done
  docker rm -f nearhome-rtsp-sim 2>/dev/null || true
  log "All streams stopped"
}

cmd_status() {
  log "RTSP Simulator Status:"
  echo ""
  printf "  %-15s %-8s %s\n" "STREAM" "STATUS" "SCENARIO"
  printf "  %-15s %-8s %s\n" "──────" "──────" "────────"

  for entry in "${STREAMS[@]}"; do
    IFS='|' read -r path video label <<< "$entry"
    local pidfile="$PID_DIR/$path.pid"
    local status="STOPPED"
    if [[ -f "$pidfile" ]]; then
      kill -0 "$(cat "$pidfile")" 2>/dev/null && status="RUNNING" || status="DEAD"
    fi
    printf "  %-15s %-8s %s\n" "$path" "$status" "$label"
  done

  echo ""
  check_mediamtx && log "MediaMTX: RUNNING" || warn "MediaMTX: DOWN"
}

# ─── Main ──────────────────────────────────────────────────────────────

CMD="${1:-start}"
case "$CMD" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *)      echo "Usage: $0 {start|stop|status}" >&2; exit 1 ;;
esac
