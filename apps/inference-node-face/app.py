"""GPU face detection and embeddings node for NearHome."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("nearhome.inference-node-face")

NODE_ID = os.environ.get("NODE_ID", "node-face-gpu-1")
NODE_ENDPOINT = os.environ.get("NODE_ENDPOINT", "http://inference-node-face:8094")
BRIDGE_URL = os.environ.get("INFERENCE_BRIDGE_URL", "http://inference-bridge:8090").rstrip("/")
ADMIN_SECRET = os.environ.get("NODE_AUTH_ADMIN_SECRET", "")
MODEL_REF = os.environ.get("FACE_MODEL_REF", "insightface-buffalo-l@1.0")
MODEL_PACK = os.environ.get("FACE_MODEL_PACK", "buffalo_l")
MODEL_ROOT = os.environ.get("FACE_MODEL_ROOT", "/models")
MAX_CONCURRENT = max(1, int(os.environ.get("NODE_MAX_CONCURRENT", "2")))
DET_SIZE = max(160, int(os.environ.get("FACE_DET_SIZE", "640")))

app = FastAPI(title="NearHome Face GPU Node", version="1.0.0")
_model: Any = None
_access_token = ""
_registered = False
_queue_depth = 0
_total = 0
_total_ms = 0.0
_last_ms = 0
_errors = 0


def model() -> Any:
    global _model
    if _model is None:
        from insightface.app import FaceAnalysis
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        _model = FaceAnalysis(name=MODEL_PACK, root=MODEL_ROOT, providers=providers)
        _model.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE))
        logger.info("face model loaded: %s", MODEL_PACK)
    return _model


def metrics() -> dict[str, Any]:
    return {"totalInferences": _total, "avgLatencyMs": round(_total_ms / max(1, _total), 1), "lastLatencyMs": _last_ms,
            "errors": _errors, "queueDepth": _queue_depth, "modelLoaded": _model is not None, "runtime": "onnx-cuda"}


def node_payload() -> dict[str, Any]:
    return {"nodeId": NODE_ID, "runtime": "insightface", "transport": "http", "endpoint": NODE_ENDPOINT,
            "status": "online", "resources": {"cpu": 4, "gpu": 1, "vramMb": 2048},
            "capabilities": [{"capabilityId": "face-embedding", "taskTypes": ["face_detection"], "models": [MODEL_REF]}],
            "models": [MODEL_REF], "maxConcurrent": MAX_CONCURRENT, "queueDepth": _queue_depth,
            "isDrained": False, "contractVersion": "1.1", "metrics": metrics()}


async def agent_loop() -> None:
    global _access_token, _registered
    if not ADMIN_SECRET:
        logger.warning("face node cannot register: NODE_AUTH_ADMIN_SECRET is missing")
        return
    async with httpx.AsyncClient(timeout=5.0) as client:
        while True:
            try:
                if not _access_token:
                    enrolled = await client.post(f"{BRIDGE_URL}/internal/nodes/enrollment-tokens", json={"nodeId": NODE_ID, "tenantScope": "*", "ttlSeconds": 600}, headers={"x-node-auth-admin-secret": ADMIN_SECRET})
                    token = enrolled.json().get("data", {}).get("enrollmentToken", "")
                    response = await client.post(f"{BRIDGE_URL}/v1/nodes/enroll", json={"nodeId": NODE_ID, "enrollmentToken": token})
                    _access_token = response.json().get("data", {}).get("nodeAccessToken", "")
                headers = {"authorization": f"Bearer {_access_token}"}
                if not _registered:
                    response = await client.post(f"{BRIDGE_URL}/v1/nodes/register", json=node_payload(), headers=headers)
                    _registered = response.is_success
                if _registered:
                    await client.post(f"{BRIDGE_URL}/v1/nodes/heartbeat", json={"nodeId": NODE_ID, "status": "online", "queueDepth": _queue_depth, "resources": {"cpu": 4, "gpu": 1, "vramMb": 2048}, "metrics": metrics()}, headers=headers)
            except Exception as exc:
                _registered = False
                logger.warning("face node agent: %s", exc)
            await asyncio.sleep(10)


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(agent_loop())


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "inference-node-face", "nodeId": NODE_ID, "registered": _registered,
            "model": MODEL_REF, "metrics": metrics()}


@app.post("/v1/infer")
async def infer(image: UploadFile = File(...)) -> dict[str, Any]:
    global _queue_depth, _total, _total_ms, _last_ms, _errors
    started = time.monotonic()
    _queue_depth += 1
    try:
        frame = cv2.imdecode(np.frombuffer(await image.read(), np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("invalid image")
        faces = model().get(frame)
        detections = [{"label": "face", "confidence": round(float(face.det_score), 3),
                       "bbox": {"x": round(float(face.bbox[0]), 1), "y": round(float(face.bbox[1]), 1),
                                "w": round(float(face.bbox[2] - face.bbox[0]), 1), "h": round(float(face.bbox[3] - face.bbox[1]), 1)},
                       "attributes": {"embedding": face.embedding.astype(float).tolist(), "embeddingModelRef": MODEL_REF,
                                      "embeddingVersion": "1.0", "qualityScore": round(float(face.det_score), 3)}} for face in faces]
        elapsed = round((time.monotonic() - started) * 1000)
        _total += 1; _total_ms += elapsed; _last_ms = elapsed
        return {"detections": detections, "count": len(detections), "latencyMs": elapsed, "providerLatencyMs": elapsed,
                "providerMeta": {"nodeId": NODE_ID, "runtime": "insightface", "model": MODEL_REF}}
    except Exception as exc:
        _errors += 1
        raise HTTPException(500, f"face inference error: {exc}") from exc
    finally:
        _queue_depth -= 1
