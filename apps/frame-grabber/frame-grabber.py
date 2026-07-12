#!/usr/bin/env python3
"""Frame Grabber v2 — reads camera tags from API, passes detector_mode per camera."""
import os, json, time, threading, logging, cv2
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import URLError

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("frame-grabber")

DETECTOR_URL = os.environ.get("DETECTOR_URL", "http://detector:8000/detect")
FRAME_HUB_URL = os.environ.get("FRAME_HUB_URL", "").rstrip("/")
CAMERAS_JSON = os.environ.get("CAMERAS", "[]")
FPS = int(os.environ.get("FPS", "1"))
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "3"))
# API for reading camera config
API_BASE = os.environ.get("API_BASE", "http://api:3001")
API_TOKEN = os.environ.get("API_TOKEN", "")

cameras = json.loads(CAMERAS_JSON)
log.info(f"Loaded {len(cameras)} cameras")

# ├── API: fetch camera tags for detector mode ───────────────────────────
def _fetch_camera_tags() -> dict:
    """Fetch camera tags from API. Returns {cameraId: detector_mode}."""
    if not API_TOKEN:
        return {}
    try:
        req = Request(f"{API_BASE}/cameras?limit=50", headers={"Authorization": f"Bearer {API_TOKEN}"})
        resp = urlopen(req, timeout=10)
        data = json.loads(resp.read()).get("data", [])
        modes = {}
        for c in data:
            tags = c.get("tags", [])
            if isinstance(tags, str):
                try: tags = json.loads(tags)
                except: tags = []
            # Find detector_mode in tags: "detector:yolo", "detector:mediapipe", etc.
            for t in tags:
                if t.startswith("detector:"):
                    modes[c["id"]] = t.split(":", 1)[1]
                    break
            if c["id"] not in modes:
                modes[c["id"]] = "yolo"  # default
        return modes
    except Exception as e:
        log.warning(f"API fetch failed: {e}")
        return {}

_cached_modes = {}
_last_fetch = 0

def get_detector_mode(cam_id: str) -> str:
    global _cached_modes, _last_fetch
    now = time.time()
    if now - _last_fetch > 30:  # Refresh every 30s
        _cached_modes = _fetch_camera_tags()
        _last_fetch = now
    return _cached_modes.get(cam_id, "yolo")

# ─── Multi-part POST builder ─────────────────────────────────────────────
def _build_multipart(fields: dict, img_bytes: bytes) -> tuple:
    boundary = "----Boundary" + str(time.time()).replace(".", "")
    body = b""
    for key, val in fields.items():
        if key == "image":
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".encode()
            body += img_bytes
            body += b"\r\n"
        else:
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{val}\r\n".encode()
    body += f"--{boundary}--\r\n".encode()
    return body, boundary

# ─── Frame detector dispatch ──────────────────────────────────────────────
def detect_frame(cam, frame, pts: int):
    """Send a frame to Frame Hub, falling back to the legacy detector when unset."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        _, img_data = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        img_bytes = img_data.tobytes()
        if FRAME_HUB_URL:
            body, boundary = _build_multipart({
                "image": "frame.jpg", "cameraId": cam['id'], "tenantId": cam['tenant'],
                "pts": pts, "capturedAt": ts,
            }, img_bytes)
            req = Request(FRAME_HUB_URL, data=body, method="POST")
            req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
            result = json.loads(urlopen(req, timeout=15).read())
            log.info(f"[{cam['id']}] pts={pts} accepted={result.get('accepted')} motion={result.get('motionPct', 0):.4f}")
            return

        mode = get_detector_mode(cam['id'])

        if mode == "none":
            return

        body, boundary = _build_multipart({"image": "frame.jpg", "cameraId": cam['id'],
            "tenantId": cam['tenant'], "frameTs": ts, "detector_mode": mode}, img_bytes)

        req = Request(DETECTOR_URL, data=body, method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        resp = urlopen(req, timeout=30)
        result = json.loads(resp.read())
        det_count = len(result.get("detections", []))
        log.info(f"[{cam['id']}] mode={mode} {det_count} dets | {result.get('elapsedMs',0)}ms | {result.get('frameUrl','')}")
    except URLError as e:
        log.warning(f"detector error for {cam['id']}: {e}")
    except Exception as e:
        log.warning(f"error for {cam['id']}: {e}")

def _build_multipart(fields: dict, img_bytes: bytes) -> tuple:
    """Build multipart form-data body."""
    boundary = "----Boundary" + str(time.time()).replace(".", "")
    body = b""
    for key, val in fields.items():
        if key == "image":
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".encode()
            body += img_bytes
            body += b"\r\n"
        else:
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{val}\r\n".encode()
    body += f"--{boundary}--\r\n".encode()
    return body, boundary

def camera_loop(cam):
    """Each camera: persistent OpenCV capture, send to detector at interval."""
    cap = None
    while True:
        try:
            if cap is None or not cap.isOpened():
                log.info(f"[{cam['id']}] connecting...")
                cap = cv2.VideoCapture(cam['rtsp'])
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                ret, frame = cap.read()
                if not ret:
                    cap.release(); cap = None
                    time.sleep(2); continue
                log.info(f"[{cam['id']}] connected | {frame.shape[1]}x{frame.shape[0]}")

            rest = 1.0 / FPS
            t0 = time.monotonic()
            with threading.Semaphore(MAX_CONCURRENT):
                ret, frame = cap.read()
            if not ret:
                cap.release(); cap = None; continue

            # Scale to 640px
            h, w = frame.shape[:2]
            if w > 640:
                s = 640.0 / w
                frame = cv2.resize(frame, (int(w*s), int(h*s)), interpolation=cv2.INTER_LINEAR)

            stream_pts = cap.get(cv2.CAP_PROP_POS_MSEC)
            # Some RTSP implementations do not expose PTS through OpenCV. Keep an
            # explicit millisecond fallback so frame ids remain monotonic enough to correlate.
            pts = int(stream_pts) if stream_pts > 0 else time.time_ns() // 1_000_000
            detect_frame(cam, frame, pts)

            elapsed = time.monotonic() - t0
            sleep = max(0, rest - elapsed)
            if sleep > 0: time.sleep(sleep)
        except Exception as e:
            log.warning(f"[{cam['id']}] loop error: {e}")
            if cap: cap.release(); cap = None
            time.sleep(2)

if __name__ == "__main__":
    threads = []
    for cam in cameras:
        t = threading.Thread(target=camera_loop, args=(cam,), daemon=True)
        t.start(); threads.append(t)
        time.sleep(0.3)
    log.info(f"{len(cameras)} cameras @ {FPS} FPS")
    for t in threads: t.join()
