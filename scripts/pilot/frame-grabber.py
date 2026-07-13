#!/usr/bin/env python3
"""
FrameGrabber — NearHome POC
Periodically captures frames from RTSP streams, sends to YOLO via inference-bridge,
and publishes detection events to event-gateway.

Usage:
  python3 scripts/pilot/frame-grabber.py [--interval 2] [--cameras cam1,cam2]
"""

import subprocess, json, os, sys, time, argparse, signal, logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("frame-grabber")

# ── Config ────────────────────────────────────────────────────────────────
DEFAULT_INTERVAL = 3          # seconds between polls per camera
DEFAULT_BRIDGE_URL = "http://localhost:8080/infer/v1/infer/hf/yolo"
DEFAULT_EVENT_URL = "http://localhost:8080/events/internal/events/publish"
DEFAULT_EVENT_SECRET = "dev-event-publish-secret"

# Camera registry: (cameraId, tenantId, rtspUrl)
DEFAULT_CAMERAS = [
    # Tenant A — Oficinas Corporativas
    ("cam-a-entrada", "tenant-a-oficinas", "rtsp://localhost:8554/entrance-frontal"),
    ("cam-a-pasillo", "tenant-a-oficinas", "rtsp://localhost:8554/entrance-corridor"),
    ("cam-a-exterior", "tenant-a-oficinas", "rtsp://localhost:8554/towncentre"),
    # Tenant B — Deposito Logistica
    ("cam-b-ingreso", "tenant-b-logistica", "rtsp://localhost:8554/pets-campus"),
    ("cam-b-bodega", "tenant-b-logistica", "rtsp://localhost:8554/mall-interior"),
    ("cam-b-muelle", "tenant-b-logistica", "rtsp://localhost:8554/browse-tienda"),
]

# ── Frame Capture ─────────────────────────────────────────────────────────

def capture_frame(rtsp_url: str, output_path: str) -> bool:
    """Capture a single frame from RTSP stream using ffmpeg."""
    cmd = [
        "ffmpeg", "-y", "-rtsp_transport", "tcp",
        "-i", rtsp_url,
        "-vframes", "1", "-q:v", "2",
        output_path
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=15)
    if r.returncode != 0:
        log.warning(f"ffmpeg failed for {rtsp_url}: {r.stderr.decode()[:100]}")
        return False
    if not os.path.exists(output_path) or os.path.getsize(output_path) < 100:
        log.warning(f"Empty/bad frame for {rtsp_url}")
        return False
    return True

# ── YOLO Inference ────────────────────────────────────────────────────────

def infer_yolo(image_path: str, bridge_url: str, camera_id: str, tenant_id: str) -> Optional[dict]:
    """Send frame to YOLO inference-bridge. Returns detections dict or None."""
    try:
        with open(image_path, "rb") as f:
            files = {"file": (f"{camera_id}.jpg", f, "image/jpeg")}
            data = {
                "tenantId": tenant_id,
                "cameraId": camera_id,
                "frameTs": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            r = subprocess.run(
                ["curl", "-s", "--max-time", "60", "-X", "POST", bridge_url,
                 "-F", f"file=@{image_path};type=image/jpeg",
                 "-F", f"tenantId={tenant_id}",
                 "-F", f"cameraId={camera_id}",
                 "-F", f"frameTs={data['frameTs']}"],
                capture_output=True, text=True, timeout=65
            )
            if r.returncode != 0:
                log.warning(f"curl failed for {camera_id}: {r.stderr[:100]}")
                return None
            result = json.loads(r.stdout)
            return result
    except Exception as e:
        log.error(f"Inference error for {camera_id}: {e}")
        return None

# ── Event Publication ─────────────────────────────────────────────────────

def publish_events(detections: List[dict], camera_id: str, tenant_id: str,
                   event_url: str, secret: str, frame_ts: str):
    """Publish each detection as an event to event-gateway."""
    for det in detections:
        payload = {
            "eventType": "detection.object",
            "tenantId": tenant_id,
            "cameraId": camera_id,
            "payload": {
                "label": det.get("label", "unknown"),
                "confidence": round(det.get("confidence", 0.0), 3),
                "bbox": det.get("bbox", {}),
                "frameTimestamp": frame_ts,
            }
        }
        try:
            r = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                 "-X", "POST", event_url,
                 "-H", "content-type: application/json",
                 "-H", f"x-event-publish-secret: {secret}",
                 "-d", json.dumps(payload)],
                capture_output=True, text=True, timeout=5
            )
            if r.stdout.strip() != "202":
                log.warning(f"Publish failed for {camera_id}/{det.get('label')}: {r.stdout.strip()}")
        except Exception as e:
            log.error(f"Publish error: {e}")

# ── Main Loop ─────────────────────────────────────────────────────────────

running = True

def shutdown(sig, frame):
    global running
    log.info("Shutting down...")
    running = False

def main():
    global running
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    parser = argparse.ArgumentParser(description="NearHome Frame Grabber")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL,
                        help=f"Poll interval in seconds (default: {DEFAULT_INTERVAL})")
    parser.add_argument("--bridge", default=DEFAULT_BRIDGE_URL)
    parser.add_argument("--events", default=DEFAULT_EVENT_URL)
    parser.add_argument("--secret", default=DEFAULT_EVENT_SECRET)
    parser.add_argument("--cameras", nargs="*", default=[],
                        help="Camera IDs to process (default: all)")
    args = parser.parse_args()

    cameras = [c for c in DEFAULT_CAMERAS if not args.cameras or c[0] in args.cameras]
    tmp_dir = "/tmp/frame-grabber"
    os.makedirs(tmp_dir, exist_ok=True)

    log.info(f"FrameGrabber started: {len(cameras)} cameras, {args.interval}s interval")
    for cid, tid, url in cameras:
        log.info(f"  {tid}/{cid} ← {url}")

    frame_count = 0
    error_count = 0

    while running:
        for camera_id, tenant_id, rtsp_url in cameras:
            if not running:
                break
            frame_path = os.path.join(tmp_dir, f"{camera_id}.jpg")

            # Capture
            ok = capture_frame(rtsp_url, frame_path)
            if not ok:
                error_count += 1
                continue

            frame_size = os.path.getsize(frame_path)
            frame_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

            # Infer
            result = infer_yolo(frame_path, args.bridge, camera_id, tenant_id)
            if result is None:
                error_count += 1
                continue

            detections = result.get("detections", [])
            latency = result.get("providerLatencyMs", 0)
            frame_count += 1

            if detections:
                log.info(f"[{camera_id}] {len(detections)} detections | {frame_size}KB | {latency}ms")
                publish_events(detections, camera_id, tenant_id,
                               args.events, args.secret, frame_ts)

        # Print stats
        log.debug(f"Cycle: {frame_count} frames, {error_count} errors")

        # Wait for next interval
        time.sleep(args.interval)

    log.info(f"FrameGrabber stopped: {frame_count} frames, {error_count} errors")

if __name__ == "__main__":
    main()
