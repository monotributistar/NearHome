"""
NearHome Inference Node — TensorRT (ultra-fast YOLO on RTX 3070).
Loads yolo11n.engine (FP16), registers with inference-bridge.
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
logger = logging.getLogger("nearhome.inference-node-tensorrt")

# ─── Config ───────────────────────────────────────────────────────────
NODE_ID = os.environ.get("NODE_ID", "node-tensorrt-1")
NODE_RUNTIME = os.environ.get("NODE_RUNTIME", "tensorrt")
NODE_ENDPOINT = os.environ.get("NODE_ENDPOINT", "http://localhost:8093")
NODE_MAX_CONCURRENT = max(1, int(os.environ.get("NODE_MAX_CONCURRENT", "12")))
NODE_RESOURCES = {
    "cpu": max(0, int(os.environ.get("NODE_RESOURCES_CPU", "4"))),
    "gpu": max(0, int(os.environ.get("NODE_RESOURCES_GPU", "1"))),
    "vramMb": max(0, int(os.environ.get("NODE_RESOURCES_VRAM_MB", "8192"))),
}
NODE_MODELS = [m.strip() for m in os.environ.get("NODE_MODELS", "yolo11n@1.0").split(",") if m.strip()]
NODE_TASK_TYPES = [t.strip() for t in os.environ.get("NODE_TASK_TYPES", "object_detection").split(",") if t.strip()]

YOLO_MODEL = os.environ.get("YOLO_MODEL", "yolo11n.engine")
YOLO_CONF = float(os.environ.get("YOLO_CONF", "0.25"))
YOLO_MAX_DET = int(os.environ.get("YOLO_MAX_DET", "20"))
YOLO_RESOLUTION = int(os.environ.get("YOLO_RESOLUTION", "640"))

INFERENCE_BRIDGE_URL = os.environ.get("INFERENCE_BRIDGE_URL", "http://localhost:8090").rstrip("/")
NODE_HEARTBEAT_INTERVAL_MS = max(2000, int(os.environ.get("NODE_HEARTBEAT_INTERVAL_MS", "10000")))
NODE_ENROLLMENT_TOKEN = os.environ.get("NODE_ENROLLMENT_TOKEN", "").strip()
NODE_AUTH_ADMIN_SECRET = os.environ.get("NODE_AUTH_ADMIN_SECRET", "").strip()

app = FastAPI(title="NearHome Inference Node TensorRT", version="1.0.0")

# ─── YOLO Model (TensorRT engine) ────────────────────────────────────
_yolo_model = None
_yolo_loaded_at = 0.0
_model_exported = False

def get_model():
    global _yolo_model, _yolo_loaded_at, _model_exported
    if _yolo_model is None:
        t0 = time.monotonic()
        from ultralytics import YOLO

        model_path = YOLO_MODEL
        # Si el .engine no existe, exportarlo desde .pt
        if not os.path.exists(model_path):
            pt_path = model_path.replace(".engine", ".pt")
            if os.path.exists(pt_path):
                logger.info(f"exporting {pt_path} → {model_path} (TensorRT FP16)...")
                model = YOLO(pt_path)
                model.export(format="engine", half=True, imgsz=YOLO_RESOLUTION)
                _model_exported = True
                logger.info(f"export complete")
            else:
                logger.warning(f"neither {model_path} nor {pt_path} found, using default")
                model_path = "yolo11n.pt"

        _yolo_model = YOLO(model_path)
        _yolo_loaded_at = time.monotonic()
        logger.info(f"model {model_path} loaded in {_yolo_loaded_at - t0:.1f}s")
    return _yolo_model

# ─── Metrics ──────────────────────────────────────────────────────────
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
            "runtime": "tensorrt",
            "precision": "fp16",
        }

metrics = InferenceMetrics()

# ─── COCO labels ──────────────────────────────────────────────────────
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

def infer_bytes(image_bytes: bytes) -> List[Dict[str, Any]]:
    import cv2
    import numpy as np

    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        logger.warning("failed to decode image")
        return []

    h, w = img.shape[:2]
    if YOLO_RESOLUTION > 0 and w > YOLO_RESOLUTION:
        scale = YOLO_RESOLUTION / w
        new_w, new_h = int(w * scale), int(h * scale)
        img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

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

# ─── Node Agent ───────────────────────────────────────────────────────
agent_state = type("AgentState", (), {"access_token": None, "registered": False, "last_error": None})()
agent_task: Optional[asyncio.Task] = None

def _node_payload():
    return {
        "nodeId": NODE_ID,
        "runtime": NODE_RUNTIME,
        "transport": "http",
        "endpoint": NODE_ENDPOINT,
        "status": "online",
        "resources": NODE_RESOURCES,
        "capabilities": [{
            "capabilityId": f"{NODE_RUNTIME}-default",
            "taskTypes": NODE_TASK_TYPES,
            "models": NODE_MODELS,
            "qualities": ["fastest", "ultra"],
        }],
        "models": NODE_MODELS,
        "maxConcurrent": NODE_MAX_CONCURRENT,
        "queueDepth": metrics.queue_depth,
        "isDrained": False,
        "contractVersion": "1.0",
        "metrics": metrics.snapshot(),
    }

async def _agent_loop():
    logger.info(f"tensorrt agent started: {NODE_ID} → {INFERENCE_BRIDGE_URL}")
    async with httpx.AsyncClient(timeout=10.0) as client:
        while True:
            try:
                if not agent_state.access_token:
                    r = await client.post(
                        f"{INFERENCE_BRIDGE_URL}/internal/nodes/enrollment-tokens",
                        json={"nodeId": NODE_ID, "tenantScope": "*", "ttlSeconds": 600},
                        headers={"x-node-auth-admin-secret": NODE_AUTH_ADMIN_SECRET},
                    )
                    if r.status_code == 200:
                        enrollment_token = r.json().get("data", {}).get("enrollmentToken", "")
                        if enrollment_token:
                            r2 = await client.post(
                                f"{INFERENCE_BRIDGE_URL}/v1/nodes/enroll",
                                json={"nodeId": NODE_ID, "enrollmentToken": enrollment_token},
                            )
                            if r2.status_code == 200:
                                body = r2.json().get("data", {})
                                agent_state.access_token = body.get("nodeAccessToken")
                                logger.info(f"node enrolled: {NODE_ID}")

                if agent_state.access_token and not agent_state.registered:
                    r = await client.post(
                        f"{INFERENCE_BRIDGE_URL}/v1/nodes/register",
                        json=_node_payload(),
                        headers={"authorization": f"Bearer {agent_state.access_token}"},
                    )
                    if r.status_code == 200:
                        agent_state.registered = True
                        logger.info(f"node registered: {NODE_ID} endpoint={NODE_ENDPOINT}")

                if agent_state.access_token:
                    await client.post(
                        f"{INFERENCE_BRIDGE_URL}/v1/nodes/heartbeat",
                        json={"nodeId": NODE_ID, "status": "online",
                              "queueDepth": metrics.queue_depth, "resources": NODE_RESOURCES,
                              "metrics": metrics.snapshot()},
                        headers={"authorization": f"Bearer {agent_state.access_token}"},
                    )

                await asyncio.sleep(NODE_HEARTBEAT_INTERVAL_MS / 1000)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"agent: {e}")
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

# ─── Routes ───────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "ok": True,
        "service": f"inference-node-{NODE_RUNTIME}",
        "node": {
            "nodeId": NODE_ID,
            "registered": agent_state.registered,
            "runtime": NODE_RUNTIME,
            "model": YOLO_MODEL,
            "lastError": agent_state.last_error,
            "bridge": INFERENCE_BRIDGE_URL,
        },
        "metrics": metrics.snapshot(),
        "modelExported": _model_exported,
    }

@app.get("/v1/capabilities")
def capabilities():
    return {"data": {"taskTypes": NODE_TASK_TYPES, "models": NODE_MODELS}}

@app.post("/v1/infer")
async def infer(
    image: UploadFile = File(...),
    conf: Optional[float] = Form(None),
    max_det: Optional[int] = Form(None),
):
    t0 = time.monotonic()
    metrics.queue_depth += 1
    try:
        image_bytes = await image.read()
        dets = infer_bytes(image_bytes)
        ms = (time.monotonic() - t0) * 1000
        metrics.record(ms, True)
        return {
            "detections": dets,
            "count": len(dets),
            "latencyMs": round(ms),
            "nodeId": NODE_ID,
            "model": YOLO_MODEL,
            "config": {"conf": conf or YOLO_CONF, "max_det": max_det or YOLO_MAX_DET},
        }
    except Exception as e:
        metrics.record(0, False)
        raise HTTPException(500, f"inference error: {e}")
    finally:
        metrics.queue_depth -= 1
