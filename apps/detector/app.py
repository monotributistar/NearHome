"""
NearHome Detector Service
Receives frames → YOLO → saves frame + detection to DB → publishes event.

POST /detect  (multipart: image, cameraId, tenantId, frameTs)
  → saves frame to /data/frames/{tenant}/{camera}/{ts}.jpg
  → runs YOLO
  → creates DetectionObservation via API
  → publishes SSE event via event-gateway
  → returns {frameUrl, detections}
"""
import os, json, time, uuid, asyncio
from datetime import datetime, timezone
from pathlib import Path
import aiofiles
import httpx
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from ultralytics import YOLO

app = FastAPI(title="NearHome Detector")

# ─── Config ─────────────────────────────────────────────────────────────
FRAMES_DIR = Path(os.environ.get("FRAMES_DIR", "/data/frames"))
API_URL = os.environ.get("API_URL", "http://api:3001")
EVENT_URL = os.environ.get("EVENT_URL", "http://event-gateway:3011")
EVENT_SECRET = os.environ.get("EVENT_PUBLISH_SECRET", "dev-event-publish-secret")
YOLO_MODEL = os.environ.get("YOLO_MODEL", "yolo11n.pt")
JWT_TOKEN = os.environ.get("DETECTOR_JWT", "")

# ─── YOLO Model (lazy load) ────────────────────────────────────────────
_model = None
_trackers = {}  # camera_id → Ultralytics predictor (tracker state)

COCO_CLASSES = [
    "person","bicycle","car","motorcycle","airplane","bus","train","truck","boat",
    "traffic light","fire hydrant","stop sign","parking meter","bench","bird","cat",
    "dog","horse","sheep","cow","elephant","bear","zebra","giraffe","backpack",
    "umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball",
    "kite","baseball bat","baseball glove","skateboard","surfboard","tennis racket",
    "bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple",
    "sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake",
    "chair","couch","potted plant","bed","dining table","toilet","tv","laptop",
    "mouse","remote","keyboard","cell phone","microwave","oven","toaster","sink",
    "refrigerator","book","clock","vase","scissors","teddy bear","hair drier",
    "toothbrush"
]

def _coco_label(cls_id: int) -> str:
    return COCO_CLASSES[cls_id] if 0 <= cls_id < len(COCO_CLASSES) else str(cls_id)

def get_model():
    global _model
    if _model is None:
        t0 = time.monotonic()
        from ultralytics import YOLO
        _model = YOLO(YOLO_MODEL)
        print(f"YOLO loaded in {time.monotonic()-t0:.1f}s")
    return _model

def infer(image_path, conf=0.25, max_det=10, imgsz=480, camera_id=None):
    """Run YOLO with ByteTrack tracking. Returns detections with track IDs.
    Uses per-camera tracker state for consistent track IDs across frames.
    """
    model = get_model()
    # Use track() with per-camera persistence for consistent track IDs
    results = model.track(image_path, verbose=False, conf=conf, max_det=max_det, imgsz=imgsz,
                          persist=camera_id is not None,
                          tracker='bytetrack.yaml' if camera_id else None)
    dets = []
    for b in results[0].boxes:
        xyxy = b.xyxy[0].tolist()
        cls_id = int(b.cls.item())
        track_id = int(b.id.item()) if b.id is not None else None
        dets.append({
            "label": _coco_label(cls_id),
            "classId": cls_id,
            "trackId": track_id,
            "confidence": round(float(b.conf.item()), 3),
            "bbox": {"x": round(xyxy[0],1), "y": round(xyxy[1],1),
                     "w": round(xyxy[2]-xyxy[0],1), "h": round(xyxy[3]-xyxy[1],1)},
        })
    return dets

# ─── Frame Storage ──────────────────────────────────────────────────────
async def save_frame(data: bytes, tenant_id: str, camera_id: str, ts: str) -> str:
    """Save frame image, return relative path."""
    frame_dir = FRAMES_DIR / tenant_id / camera_id
    frame_dir.mkdir(parents=True, exist_ok=True)

    # Sanitize timestamp for filename
    safe_ts = ts.replace(":", "-").replace("T", "_").replace("Z", "")
    filename = f"{safe_ts}.jpg"
    filepath = frame_dir / filename

    async with aiofiles.open(filepath, "wb") as f:
        await f.write(data)

    # Return relative URL path
    return f"/frames/{tenant_id}/{camera_id}/{filename}"

# ─── API Calls ──────────────────────────────────────────────────────────
async def create_detection_in_db(detections: list, frame_url: str,
                                  tenant_id: str, camera_id: str, ts: str):
    """Batch store all detections via API (fire-and-forget)."""
    if not JWT_TOKEN or not detections:
        return

    payload = {
        "tenantId": tenant_id,
        "cameraId": camera_id,
        "observations": [{
            "label": d["label"],
            "confidence": d["confidence"],
            "bbox": d["bbox"],
        } for d in detections[:20]],
        "frameUrl": frame_url,
        "frameTimestamp": ts,
    }

    try:
        async with httpx.AsyncClient(base_url=API_URL, timeout=10) as client:
            r = await client.post(
                "/internal/detections/observations/batch",
                json=payload,
                headers={
                    "Authorization": f"Bearer {JWT_TOKEN}",
                    "X-Tenant-Id": tenant_id,
                }
            )
            if r.status_code not in (200, 201):
                print(f"  DB batch: {r.status_code}")
            else:
                data = r.json()
                print(f"  DB: {data.get('count',0)} obs")
    except Exception as e:
        print(f"  DB error: {e}")


async def publish_event(detections: list, frame_url: str, frame_w: int, frame_h: int,
                         tenant_id: str, camera_id: str, ts: str):
    """Publish single batch event with all detections (fire-and-forget)."""
    if not detections:
        return

    event = {
        "eventType": "detection.object",
        "tenantId": tenant_id,
        "cameraId": camera_id,
        "payload": {
            "detections": [{"label": d["label"], "confidence": d["confidence"], "bbox": d["bbox"]}
                          for d in detections[:20]],
            "frameWidth": frame_w,
            "frameHeight": frame_h,
            "frameUrl": frame_url,
            "frameTimestamp": ts,
        },
        "occurredAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    try:
        async with httpx.AsyncClient(base_url=EVENT_URL, timeout=5) as client:
            await client.post(
                "/internal/events/publish",
                json=event,
                headers={"x-event-publish-secret": EVENT_SECRET}
            )
    except:
        pass

# ─── Detection endpoint ─────────────────────────────────────────────────
@app.post("/detect")
async def detect(
    image: UploadFile = File(...),
    cameraId: str = Form(...),
    tenantId: str = Form(...),
    frameTs: str = Form(""),
    detector_mode: str = Form("yolo"),
):
    t0 = time.monotonic()
    ts = frameTs or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Read image bytes
    img_bytes = await image.read()
    if not img_bytes:
        raise HTTPException(400, "Empty image")

    # Save frame
    frame_url = await save_frame(img_bytes, tenantId, cameraId, ts)

    # Save to temp file for YOLO
    tmp = f"/tmp/detect_{cameraId}.jpg"
    async with aiofiles.open(tmp, "wb") as f:
        await f.write(img_bytes)

    # Run YOLO with per-camera tracking
    dets = infer(tmp, camera_id=cameraId)

    # Get frame dimensions
    from PIL import Image
    with Image.open(tmp) as img:
        frame_w, frame_h = img.size

    # Persist to DB
    await create_detection_in_db(dets, frame_url, tenantId, cameraId, ts)

    # Publish event
    await publish_event(dets, frame_url, frame_w, frame_h, tenantId, cameraId, ts)

    elapsed = (time.monotonic() - t0) * 1000
    print(f"[{cameraId}] {len(dets)} dets | {frame_w}x{frame_h} | {elapsed:.0f}ms | {frame_url}")

    return {
        "status": "ok",
        "detections": dets,
        "frameUrl": frame_url,
        "frameWidth": frame_w,
        "frameHeight": frame_h,
        "elapsedMs": round(elapsed),
    }

@app.get("/health")
def health():
    return {"ok": True, "service": "detector", "model": YOLO_MODEL}
