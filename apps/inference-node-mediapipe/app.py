"""NearHome Inference Node — MediaPipe real, configurable, observable.
Runs pose estimation for person detection (~15ms on CPU).
"""
from __future__ import annotations

import asyncio, logging, os, time, json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx
import cv2
import numpy as np
import mediapipe as mp
from fastapi import FastAPI, File, Form, UploadFile, HTTPException

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("nearhome.inference-node-mediapipe")

NODE_ID = os.environ.get("NODE_ID", "node-mediapipe-1")
NODE_RUNTIME = os.environ.get("NODE_RUNTIME", "mediapipe")
NODE_ENDPOINT = os.environ.get("NODE_ENDPOINT", "http://inference-node-mediapipe:8092")
NODE_MAX_CONCURRENT = max(1, int(os.environ.get("NODE_MAX_CONCURRENT", "4")))
NODE_RESOURCES = {
    "cpu": max(0, int(os.environ.get("NODE_RESOURCES_CPU", "4"))),
    "gpu": 0,
    "vramMb": 0,
}
NODE_MODELS = [m.strip() for m in os.environ.get("NODE_MODELS", "mediapipe_pose@0.10.0").split(",") if m.strip()]
NODE_TASK_TYPES = [t.strip() for t in os.environ.get("NODE_TASK_TYPES", "pose_estimation,person_detection").split(",") if t.strip()]

# MediaPipe config
MP_MIN_DET_CONF = float(os.environ.get("MP_MIN_DET_CONF", "0.5"))
MP_MIN_TRACK_CONF = float(os.environ.get("MP_MIN_TRACK_CONF", "0.5"))

INFERENCE_BRIDGE_URL = os.environ.get("INFERENCE_BRIDGE_URL", "http://inference-bridge:8090").rstrip("/")
NODE_HEARTBEAT_INTERVAL_MS = max(2000, int(os.environ.get("NODE_HEARTBEAT_INTERVAL_MS", "10000")))
NODE_ENROLLMENT_TOKEN = os.environ.get("NODE_ENROLLMENT_TOKEN", "").strip()
NODE_AUTH_ADMIN_SECRET = os.environ.get("NODE_AUTH_ADMIN_SECRET", "").strip()

app = FastAPI(title="NearHome Inference Node MediaPipe", version="0.3.0")

# ─── MediaPipe (lazy-loaded singleton) ───────────────────────────────────
_pose = None
_pose_loaded_at = 0.0

def get_pose():
    global _pose, _pose_loaded_at
    if _pose is None:
        t0 = time.monotonic()
        _pose = mp.solutions.pose.Pose(
            static_image_mode=True,
            model_complexity=1,
            min_detection_confidence=MP_MIN_DET_CONF,
            min_tracking_confidence=MP_MIN_TRACK_CONF,
        )
        _pose_loaded_at = time.monotonic()
        logger.info(f"MediaPipe Pose loaded in {_pose_loaded_at - t0:.1f}s")
    return _pose

# ─── Inference Metrics ───────────────────────────────────────────────────
class InferenceMetrics:
    def __init__(self):
        self.total = 0
        self.total_ms = 0.0
        self.errors = 0
        self.queue_depth = 0
        self.last_inference_ms = 0

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
            "modelLoaded": _pose is not None,
        }

metrics = InferenceMetrics()

# ─── MediaPipe Inference ─────────────────────────────────────────────────
POSE_LANDMARK_NAMES = [
    "nose","left_eye_inner","left_eye","left_eye_outer","right_eye_inner",
    "right_eye","right_eye_outer","left_ear","right_ear","mouth_left",
    "mouth_right","left_shoulder","right_shoulder","left_elbow","right_elbow",
    "left_wrist","right_wrist","left_pinky","right_pinky","left_index",
    "right_index","left_thumb","right_thumb","left_hip","right_hip",
    "left_knee","right_knee","left_ankle","right_ankle","left_heel",
    "right_heel","left_foot_index","right_foot_index",
]

def infer_bytes(image_bytes: bytes) -> List[Dict[str, Any]]:
    """Run MediaPipe Pose on image bytes. Returns person detections with keypoints."""
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return []

    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    h, w = img.shape[:2]

    pose = get_pose()
    results = pose.process(rgb)

    detections = []
    if results.pose_landmarks:
        landmarks = results.pose_landmarks.landmark
        keypoints = [{"x": lm.x, "y": lm.y, "z": round(lm.z, 3), "visibility": round(lm.visibility, 3)}
                     for lm in landmarks]

        # Compute bounding box from landmarks
        xs = [lm.x * w for lm in landmarks if lm.visibility > 0.3]
        ys = [lm.y * h for lm in landmarks if lm.visibility > 0.3]

        if xs and ys:
            x_min, x_max = min(xs), max(xs)
            y_min, y_max = min(ys), max(ys)
            # Confidence = average visibility of key body parts
            conf_parts = [landmarks[mp.solutions.pose.PoseLandmark.LEFT_SHOULDER.value].visibility,
                         landmarks[mp.solutions.pose.PoseLandmark.RIGHT_SHOULDER.value].visibility,
                         landmarks[mp.solutions.pose.PoseLandmark.LEFT_HIP.value].visibility,
                         landmarks[mp.solutions.pose.PoseLandmark.RIGHT_HIP.value].visibility]
            confidence = round(sum(conf_parts) / len(conf_parts), 3)

            detections.append({
                "label": "person",
                "confidence": confidence,
                "bbox": {
                    "x": round(x_min, 1),
                    "y": round(y_min, 1),
                    "w": round(x_max - x_min, 1),
                    "h": round(y_max - y_min, 1),
                },
                "keypoints": keypoints,
                "numKeypoints": len([k for k in keypoints if k["visibility"] > 0.5]),
            })

    return detections

# ─── Node Agent ──────────────────────────────────────────────────────────
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
        "transport": "http",
        "endpoint": NODE_ENDPOINT,
        "status": "online",
        "resources": NODE_RESOURCES,
        "capabilities": [{
            "capabilityId": f"{NODE_RUNTIME}-default",
            "taskTypes": NODE_TASK_TYPES,
            "models": NODE_MODELS,
        }],
        "models": NODE_MODELS,
        "maxConcurrent": NODE_MAX_CONCURRENT,
        "queueDepth": metrics.queue_depth,
        "isDrained": False,
        "contractVersion": "1.0",
        "metrics": metrics.snapshot(),
    }

async def _enroll(client: httpx.AsyncClient) -> None:
    token = NODE_ENROLLMENT_TOKEN
    if not token and NODE_AUTH_ADMIN_SECRET:
        r = await client.post(
            f"{INFERENCE_BRIDGE_URL}/internal/nodes/enrollment-tokens",
            json={"nodeId": NODE_ID, "tenantScope": "*", "ttlSeconds": 600},
            headers={"x-node-auth-admin-secret": NODE_AUTH_ADMIN_SECRET},
        )
        r.raise_for_status()
        token = r.json().get("data", {}).get("enrollmentToken", "")
    if token:
        r = await client.post(
            f"{INFERENCE_BRIDGE_URL}/v1/nodes/enroll",
            json={"nodeId": NODE_ID, "enrollmentToken": token},
        )
        r.raise_for_status()
        agent_state.access_token = r.json().get("data", {}).get("nodeAccessToken")
        logger.info("enrolled: %s", NODE_ID)

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
        logger.info("registered: %s", NODE_ID)

async def _heartbeat(client: httpx.AsyncClient) -> None:
    if not agent_state.access_token:
        return
    payload = {"nodeId": NODE_ID, "status": "online", "queueDepth": metrics.queue_depth,
               "resources": NODE_RESOURCES, "metrics": metrics.snapshot()}
    r = await client.post(
        f"{INFERENCE_BRIDGE_URL}/v1/nodes/heartbeat", json=payload,
        headers={"authorization": f"Bearer {agent_state.access_token}"},
    )
    if r.status_code == 401:
        agent_state.registered = False
        agent_state.access_token = None

async def _agent_loop():
    logger.info("agent started: %s", NODE_ID)
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
        "service": "inference-node-mediapipe",
        "nodeId": NODE_ID,
        "config": {"minDetConf": MP_MIN_DET_CONF, "minTrackConf": MP_MIN_TRACK_CONF},
        "metrics": metrics.snapshot(),
        "registered": agent_state.registered,
    }

@app.get("/v1/capabilities")
def capabilities():
    return {"data": {"taskTypes": NODE_TASK_TYPES, "models": NODE_MODELS,
                     "config": {"resources": NODE_RESOURCES}}}

@app.post("/v1/infer")
async def infer(image: UploadFile = File(...)):
    """Run MediaPipe Pose estimation on uploaded image. Returns person detections."""
    t0 = time.monotonic()
    metrics.queue_depth += 1
    try:
        image_bytes = await image.read()
        dets = infer_bytes(image_bytes)
        ms = (time.monotonic() - t0) * 1000
        metrics.record(ms, True)
        return {"detections": dets, "count": len(dets), "latencyMs": round(ms),
                "nodeId": NODE_ID, "runtime": "mediapipe"}
    except Exception as e:
        metrics.record(0, False)
        raise HTTPException(500, f"mediapipe error: {e}")
    finally:
        metrics.queue_depth -= 1
