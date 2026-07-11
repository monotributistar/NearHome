"""
NearHome Inference Node — YOLO real, configurable, observable.
Registers with control plane, reports metrics, runs YOLO on-demand.

Config via env vars:
  NODE_ID, NODE_MODELS, NODE_MAX_CONCURRENT, NODE_RESOURCES_*
  YOLO_MODEL, YOLO_CONF, YOLO_MAX_DET, YOLO_RESOLUTION
"""
from __future__ import annotations

import asyncio, logging, os, time, json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("nearhome.inference-node-yolo")

# ─── Node Configuration ──────────────────────────────────────────────────
NODE_ID = os.environ.get("NODE_ID", "node-yolo-1")
NODE_RUNTIME = os.environ.get("NODE_RUNTIME", "yolo")
NODE_TRANSPORT = os.environ.get("NODE_TRANSPORT", "http")
NODE_ENDPOINT = os.environ.get("NODE_ENDPOINT", "http://inference-node-yolo:8091")
NODE_MAX_CONCURRENT = max(1, int(os.environ.get("NODE_MAX_CONCURRENT", "4")))
NODE_RESOURCES = {
    "cpu": max(0, int(os.environ.get("NODE_RESOURCES_CPU", "4"))),
    "gpu": max(0, int(os.environ.get("NODE_RESOURCES_GPU", "0"))),
    "vramMb": max(0, int(os.environ.get("NODE_RESOURCES_VRAM_MB", "0"))),
}
NODE_MODELS = [m.strip() for m in os.environ.get("NODE_MODELS", "yolo11n@1.0").split(",") if m.strip()]
NODE_TASK_TYPES = [t.strip() for t in os.environ.get("NODE_TASK_TYPES", "object_detection").split(",") if t.strip()]

# ─── YOLO Configuration ──────────────────────────────────────────────────
YOLO_MODEL = os.environ.get("YOLO_MODEL", "yolo11n.pt")
YOLO_CONF = float(os.environ.get("YOLO_CONF", "0.25"))
YOLO_MAX_DET = int(os.environ.get("YOLO_MAX_DET", "20"))
YOLO_RESOLUTION = int(os.environ.get("YOLO_RESOLUTION", "640"))

# ─── Control plane ───────────────────────────────────────────────────────
INFERENCE_BRIDGE_URL = os.environ.get("INFERENCE_BRIDGE_URL", "http://inference-bridge:8090").rstrip("/")
NODE_HEARTBEAT_INTERVAL_MS = max(2000, int(os.environ.get("NODE_HEARTBEAT_INTERVAL_MS", "10000")))
NODE_ENROLLMENT_TOKEN = os.environ.get("NODE_ENROLLMENT_TOKEN", "").strip()
NODE_AUTH_ADMIN_SECRET = os.environ.get("NODE_AUTH_ADMIN_SECRET", "").strip()

app = FastAPI(title="NearHome Inference Node YOLO", version="0.3.0")

# ─── YOLO Model (lazy-loaded singleton) ──────────────────────────────────
_yolo_model = None
_yolo_loaded_at = 0.0

def get_model():
    global _yolo_model, _yolo_loaded_at
    if _yolo_model is None:
        t0 = time.monotonic()
        from ultralytics import YOLO
        _yolo_model = YOLO(YOLO_MODEL)
        _yolo_loaded_at = time.monotonic()
        logger.info(f"model {YOLO_MODEL} loaded in {_yolo_loaded_at - t0:.1f}s")
    return _yolo_model

# ─── Inference Metrics ───────────────────────────────────────────────────
class InferenceMetrics:
    def __init__(self):
        self.total = 0
        self.total_ms = 0.0
        self.errors = 0
        self.queue_depth = 0
        self.last_inference_ms = 0
        self.last_error = None

    def record(self, ms: float, ok: bool):
        self.total += 1
        self.total_ms += ms
        self.last_inference_ms = round(ms)
        if not ok:
            self.errors += 1

    @property
    def avg_ms(self):
        return round(self.total_ms / max(1, self.total), 1)

    def snapshot(self):
        return {
            "totalInferences": self.total,
            "avgLatencyMs": self.avg_ms,
            "lastLatencyMs": self.last_inference_ms,
            "errors": self.errors,
            "queueDepth": self.queue_depth,
            "modelLoaded": _yolo_model is not None,
            "modelLoadTimeS": round(_yolo_loaded_at - (time.monotonic() - _yolo_loaded_at), 1) if _yolo_model else None,
        }

metrics = InferenceMetrics()

# ─── YOLO Inference ──────────────────────────────────────────────────────
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

def infer_bytes(image_bytes: bytes, width: int = 640, height: int = 0) -> List[Dict[str, Any]]:
    """Run YOLO on raw image bytes. Returns detections."""
    import cv2
    import numpy as np

    # Decode image
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        logger.warning("failed to decode image")
        return []

    # Resize if needed
    h, w = img.shape[:2]
    if width > 0 and w > width:
        scale = width / w
        new_w, new_h = int(w * scale), int(h * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    # Infer
    model = get_model()
    results = model(img, verbose=False, conf=YOLO_CONF, max_det=YOLO_MAX_DET)

    dets = []
    for b in results[0].boxes:
        xyxy = b.xyxy[0].tolist()
        cls_id = int(b.cls.item())
        dets.append({
            "label": _coco_label(cls_id),
            "classId": cls_id,
            "confidence": round(float(b.conf.item()), 3),
            "bbox": {"x": round(xyxy[0], 1), "y": round(xyxy[1], 1),
                     "w": round(xyxy[2] - xyxy[0], 1), "h": round(xyxy[3] - xyxy[1], 1)},
        })
    return dets

# ─── Node Agent (enrollment + heartbeat) ─────────────────────────────────
class NodeAgentState:
    def __init__(self):
        self.access_token: Optional[str] = None
        self.registered = False
        self.last_error: Optional[str] = None

agent_state = NodeAgentState()
agent_task: Optional[asyncio.Task] = None

def _node_payload() -> Dict[str, Any]:
    return {
        "nodeId": NODE_ID,
        "runtime": NODE_RUNTIME,
        "transport": NODE_TRANSPORT,
        "endpoint": NODE_ENDPOINT,
        "status": "online",
        "resources": NODE_RESOURCES,
        "capabilities": [{
            "capabilityId": f"{NODE_RUNTIME}-default",
            "taskTypes": NODE_TASK_TYPES,
            "models": NODE_MODELS,
            "qualities": ["fast", "balanced"],
        }],
        "models": NODE_MODELS,
        "maxConcurrent": NODE_MAX_CONCURRENT,
        "queueDepth": metrics.queue_depth,
        "isDrained": False,
        "contractVersion": "1.0",
        "metrics": metrics.snapshot(),
    }

async def _enroll(client: httpx.AsyncClient) -> None:
    enrollment_token = NODE_ENROLLMENT_TOKEN
    if not enrollment_token and NODE_AUTH_ADMIN_SECRET:
        r = await client.post(
            f"{INFERENCE_BRIDGE_URL}/internal/nodes/enrollment-tokens",
            json={"nodeId": NODE_ID, "tenantScope": "*", "ttlSeconds": 600},
            headers={"x-node-auth-admin-secret": NODE_AUTH_ADMIN_SECRET},
        )
        r.raise_for_status()
        enrollment_token = r.json().get("data", {}).get("enrollmentToken", "")

    if enrollment_token:
        r = await client.post(
            f"{INFERENCE_BRIDGE_URL}/v1/nodes/enroll",
            json={"nodeId": NODE_ID, "enrollmentToken": enrollment_token},
        )
        r.raise_for_status()
        body = r.json().get("data", {})
        agent_state.access_token = body.get("nodeAccessToken")
        logger.info("node enrolled: %s", NODE_ID)

async def _register(client: httpx.AsyncClient) -> None:
    if not agent_state.access_token:
        return
    r = await client.post(
        f"{INFERENCE_BRIDGE_URL}/v1/nodes/register",
        json=_node_payload(),
        headers={"authorization": f"Bearer {agent_state.access_token}"},
    )
    if r.status_code == 200:
        agent_state.registered = True
        logger.info("node registered: %s", NODE_ID)

async def _heartbeat(client: httpx.AsyncClient) -> None:
    if not agent_state.access_token:
        return
    payload = {
        "nodeId": NODE_ID,
        "status": "online",
        "queueDepth": metrics.queue_depth,
        "resources": NODE_RESOURCES,
        "metrics": metrics.snapshot(),
    }
    r = await client.post(
        f"{INFERENCE_BRIDGE_URL}/v1/nodes/heartbeat",
        json=payload,
        headers={"authorization": f"Bearer {agent_state.access_token}"},
    )
    if r.status_code == 401:
        agent_state.registered = False
        agent_state.access_token = None

async def _agent_loop():
    logger.info("agent started: %s -> %s", NODE_ID, INFERENCE_BRIDGE_URL)
    async with httpx.AsyncClient(timeout=10.0) as client:
        while True:
            try:
                if not agent_state.access_token:
                    await _enroll(client)
                if not agent_state.registered:
                    await _register(client)
                await _heartbeat(client)
                await asyncio.sleep(NODE_HEARTBEAT_INTERVAL_MS / 1000)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("agent: %s", e)
                await asyncio.sleep(5)

@app.on_event("startup")
async def startup():
    global agent_task
    if agent_task is None:
        agent_task = asyncio.create_task(_agent_loop())

@app.on_event("shutdown")
async def shutdown():
    global agent_task
    if agent_task:
        agent_task.cancel()
        try: await agent_task
        except asyncio.CancelledError: pass

# ─── Routes ──────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "inference-node-yolo",
        "nodeId": NODE_ID,
        "model": YOLO_MODEL,
        "config": {"conf": YOLO_CONF, "max_det": YOLO_MAX_DET, "resolution": YOLO_RESOLUTION},
        "metrics": metrics.snapshot(),
        "registered": agent_state.registered,
    }

@app.get("/v1/capabilities")
def capabilities():
    return {
        "data": {
            "taskTypes": NODE_TASK_TYPES,
            "models": NODE_MODELS,
            "config": {
                "model": YOLO_MODEL,
                "conf": YOLO_CONF,
                "maxDet": YOLO_MAX_DET,
                "resolution": YOLO_RESOLUTION,
                "resources": NODE_RESOURCES,
            },
        }
    }

@app.post("/v1/infer")
async def infer(
    image: UploadFile = File(...),
    conf: Optional[float] = Form(None),
    max_det: Optional[int] = Form(None),
):
    """Run YOLO inference on uploaded image.

    Override default YOLO_CONF/YOLO_MAX_DET via form params.
    Returns detections + timing.
    """
    t0 = time.monotonic()
    metrics.queue_depth += 1

    try:
        image_bytes = await image.read()
        effective_conf = conf if conf is not None else YOLO_CONF
        effective_max_det = max_det if max_det is not None else YOLO_MAX_DET

        # Temporarily override for this request
        global saved_conf, saved_max_det
        saved_conf = YOLO_CONF
        saved_max_det = YOLO_MAX_DET

        dets = infer_bytes(image_bytes, YOLO_RESOLUTION)

        ms = (time.monotonic() - t0) * 1000
        metrics.record(ms, True)

        return {
            "detections": dets,
            "count": len(dets),
            "latencyMs": round(ms),
            "nodeId": NODE_ID,
            "model": YOLO_MODEL,
            "config": {"conf": effective_conf, "max_det": effective_max_det},
        }
    except Exception as e:
        metrics.record(0, False)
        metrics.last_error = str(e)
        raise HTTPException(500, f"inference error: {e}")
    finally:
        metrics.queue_depth -= 1
