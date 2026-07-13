#!/usr/bin/env python3
"""
FrameGrabber v2 — NearHome POC
CONCURRENT: one asyncio task per camera, all running in parallel.
Async ffmpeg + httpx — NO blocking calls, NO round-robin.

With 50 cameras at 1 FPS: each camera gets its frame every 1s.
All 50 capture + send to YOLO concurrently.
Semaphore limits concurrent YOLO calls to avoid HF Space overload.

Usage:
  python3 scripts/pilot/frame-grabber-v2.py
  python3 scripts/pilot/frame-grabber-v2.py --fps 2 --max-concurrent 5
"""

import asyncio, json, os, signal, sys, time, argparse, logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("frame-grabber-v2")

# ── Defaults ──────────────────────────────────────────────────────────────
DEFAULT_FPS = 5  # higher FPS with local YOLO
DEFAULT_MAX_CONCURRENT = 3
DEFAULT_BATCH_SIZE = 3
DEFAULT_BRIDGE = "http://localhost:8080/infer/v1/infer/hf/yolo"
DEFAULT_BATCH_BRIDGE = "http://localhost:8080/infer/v1/infer/hf/yolo-batch"
DEFAULT_EVENTS = "http://localhost:8080/events/internal/events/publish"
DEFAULT_SECRET = "dev-event-publish-secret"

# Local YOLO mode — bypasses HF Space entirely
USE_LOCAL_YOLO = True  # Set False to use HF Space

# Camera registry: (cameraId, tenantId, rtspUrl)
CAMERAS = [
    ("cam-a-entrada",   "tenant-a-oficinas",  "rtsp://localhost:8554/entrance-frontal"),
    ("cam-a-pasillo",   "tenant-a-oficinas",  "rtsp://localhost:8554/entrance-corridor"),
    ("cam-a-exterior",  "tenant-a-oficinas",  "rtsp://localhost:8554/towncentre"),
    ("cam-b-ingreso",   "tenant-b-logistica", "rtsp://localhost:8554/pets-campus"),
    ("cam-b-bodega",    "tenant-b-logistica", "rtsp://localhost:8554/mall-interior"),
    ("cam-b-muelle",    "tenant-b-logistica", "rtsp://localhost:8554/browse-tienda"),
]

# ── Async Frame Capture ───────────────────────────────────────────────────

async def capture_frame(rtsp_url: str, output_path: str) -> bool:
    """Non-blocking ffmpeg frame capture via asyncio subprocess.
    Captures at 640px width — good balance of speed vs detectability."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-rtsp_transport", "tcp",
        "-i", rtsp_url, "-vf", "scale=640:-1", "-vframes", "1", "-q:v", "2", output_path,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
    )
    try:
        rc = await asyncio.wait_for(proc.wait(), timeout=12)
        if rc != 0:
            log.warning(f"ffmpeg error for {rtsp_url}: exit={rc}")
            return False
        if not os.path.exists(output_path) or os.path.getsize(output_path) < 100:
            return False
        return True
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        log.warning(f"ffmpeg timeout for {rtsp_url}")
        return False

# ── Local YOLO (bypasses HF Space) ─────────────────────────────────────────

_YOLO_MODEL = None

def _get_yolo():
    global _YOLO_MODEL
    if _YOLO_MODEL is None:
        t0 = time.monotonic()
        from ultralytics import YOLO
        _YOLO_MODEL = YOLO("yolo11n.pt")
        log.info(f"Local YOLO loaded in {time.monotonic()-t0:.1f}s")
    return _YOLO_MODEL

async def infer_yolo_local(image_path: str) -> Optional[dict]:
    """Run YOLO locally on Apple Silicon (non-blocking via thread pool)."""
    loop = asyncio.get_running_loop()
    try:
        def _run():
            model = _get_yolo()
            results = model(image_path, verbose=False, conf=0.25)
            detections = []
            for box in results[0].boxes:
                xyxy = box.xyxy[0].tolist()
                detections.append({
                    "label": str(int(box.cls.item())),
                    "confidence": round(float(box.conf.item()), 3),
                    "bbox": {
                        "x": round(xyxy[0], 1),
                        "y": round(xyxy[1], 1),
                        "w": round(xyxy[2] - xyxy[0], 1),
                        "h": round(xyxy[3] - xyxy[1], 1),
                    },
                })
            return detections
        detections = await loop.run_in_executor(None, _run)
        return {"status": "ok", "detections": detections, "providerLatencyMs": 0}
    except Exception as e:
        log.error(f"Local YOLO error: {e}")
        return None

# ── Async Inference (HF Space) ─────────────────────────────────────────────

async def infer_yolo_hf(client, image_path: str, camera_id: str, tenant_id: str) -> Optional[dict]:
    """Non-blocking POST to inference bridge via async HTTP (multipart form)."""
    frame_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        with open(image_path, "rb") as f:
            image_data = f.read()

        # Multipart form — matches curl -F
        files = {
            "file": (f"{camera_id}.jpg", image_data, "image/jpeg"),
            "tenantId": (None, tenant_id),
            "cameraId": (None, camera_id),
            "frameTs": (None, frame_ts),
        }

        resp = await asyncio.wait_for(
            client.post(DEFAULT_BRIDGE, files=files),
            timeout=30
        )
        if resp.status_code != 200:
            log.warning(f"YOLO {camera_id}: HTTP {resp.status_code}")
            return None
        result = resp.json()
        return result
    except asyncio.TimeoutError:
        log.warning(f"YOLO timeout for {camera_id}")
        return None
    except Exception as e:
        log.error(f"YOLO error for {camera_id}: {e}")
        return None

# ── Async Event Publish ───────────────────────────────────────────────────

async def publish_events(client, detections: List[dict], camera_id: str,
                         tenant_id: str, frame_ts: str):
    """Non-blocking POST each detection to event gateway (fire & forget)."""
    for det in detections[:5]:  # max 5 events per frame to avoid flooding
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
            await asyncio.wait_for(
                client.post(DEFAULT_EVENTS, json=payload,
                    headers={"x-event-publish-secret": DEFAULT_SECRET}),
                timeout=3
            )
        except:
            pass  # fire & forget — don't block the next frame

# ── Camera Task ───────────────────────────────────────────────────────────

async def camera_loop(camera_id: str, tenant_id: str, rtsp_url: str,
                      semaphore: asyncio.Semaphore, client, tmp_dir: str,
                      fps: int):
    """Per-camera async loop: capture → infer → publish → sleep."""
    frame_path = os.path.join(tmp_dir, f"{camera_id}.jpg")
    interval = 1.0 / fps
    frame_count = 0

    while True:
        t0 = time.monotonic()

        # 1. Capture frame
        ok = await capture_frame(rtsp_url, frame_path)
        if not ok:
            await asyncio.sleep(interval)
            continue

        frame_size = os.path.getsize(frame_path)
        frame_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        # 2. Infer (with semaphore — limit concurrent YOLO calls)
        async with semaphore:
            result = await infer_yolo(client, frame_path, camera_id, tenant_id)

        if not result:
            await asyncio.sleep(interval)
            continue

        detections = result.get("detections", [])
        latency = result.get("providerLatencyMs", 0)
        frame_count += 1

        if detections:
            log.info(f"[{camera_id}] {len(detections)} dets | {frame_size//1024}KB | {latency}ms")
            # 3. Publish (fire & forget — don't await)
            asyncio.ensure_future(
                publish_events(client, detections, camera_id, tenant_id, frame_ts)
            )

        # 4. Sleep to maintain FPS
        elapsed = time.monotonic() - t0
        sleep = max(0, interval - elapsed)
        if sleep > 0:
            await asyncio.sleep(sleep)

# ── Main ──────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description="NearHome Frame Grabber v2 (concurrent)")
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS,
                        help=f"Frames per second per camera (default: {DEFAULT_FPS})")
    parser.add_argument("--max-concurrent", type=int, default=DEFAULT_MAX_CONCURRENT,
                        help=f"Max concurrent YOLO calls (default: {DEFAULT_MAX_CONCURRENT})")
    parser.add_argument("--cameras", nargs="*", default=[],
                        help="Specific camera IDs (default: all)")
    args = parser.parse_args()

    cameras = [c for c in CAMERAS if not args.cameras or c[0] in args.cameras]
    tmp_dir = "/tmp/frame-grabber"
    os.makedirs(tmp_dir, exist_ok=True)

    log.info(f"FrameGrabber v2 — {len(cameras)} cameras, {args.fps} FPS each, "
             f"max {args.max_concurrent} concurrent YOLO")

    semaphore = asyncio.Semaphore(args.max_concurrent)

    async with httpx.AsyncClient(timeout=httpx.Timeout(35.0)) as client:
        tasks = [
            asyncio.create_task(camera_loop(cid, tid, url, semaphore, client, tmp_dir, args.fps))
            for cid, tid, url in cameras
        ]

        # Wait for shutdown signal
        shutdown_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, shutdown_event.set)
            except NotImplementedError:
                # Windows fallback
                pass

        await shutdown_event.wait()
        log.info("Shutting down...")
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info("All camera tasks stopped")

if __name__ == "__main__":
    import httpx
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped by user")
