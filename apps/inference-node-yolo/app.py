from __future__ import annotations

from typing import Any, Dict, List

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="NearHome Inference Node YOLO", version="0.1.0")


class InferRequest(BaseModel):
    requestId: str
    jobId: str
    tenantId: str
    cameraId: str
    taskType: str
    modelRef: str
    mediaRef: Dict[str, Any]
    thresholds: Dict[str, Any] = Field(default_factory=dict)
    deadlineMs: int = 15000
    priority: int = 5
    provider: str = "onprem_bento"


@app.get("/health")
def health():
    return {"ok": True, "service": "inference-node-yolo"}


@app.get("/v1/capabilities")
def capabilities():
    return {
        "data": {
            "taskTypes": ["object_detection"],
            "models": ["yolo26n@1.0.0", "yolo26s@1.0.0"],
        }
    }


@app.post("/v1/infer")
def infer(payload: InferRequest):
    detections: List[Dict[str, Any]] = [
        {
            "label": "person",
            "confidence": 0.87,
            "bbox": {"x": 0.18, "y": 0.11, "w": 0.25, "h": 0.62},
            "attributes": {"model": payload.modelRef, "node": "yolo-cpu"},
        }
    ]
    return {
        "detections": detections,
        "providerLatencyMs": 22,
        "providerMeta": {"engine": "yolo", "node": "inference-node-yolo"},
    }
