from __future__ import annotations

from typing import Any, Dict, List

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="NearHome Inference Node MediaPipe", version="0.1.0")


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
    return {"ok": True, "service": "inference-node-mediapipe"}


@app.get("/v1/capabilities")
def capabilities():
    return {
        "data": {
            "taskTypes": ["pose_estimation", "action_recognition"],
            "models": ["mediapipe_pose@0.10.0"],
        }
    }


@app.post("/v1/infer")
def infer(payload: InferRequest):
    detections: List[Dict[str, Any]] = [
        {
            "label": "person_pose",
            "confidence": 0.79,
            "bbox": {"x": 0.2, "y": 0.15, "w": 0.22, "h": 0.58},
            "keypoints": [
                {"x": 0.31, "y": 0.2, "score": 0.91},
                {"x": 0.3, "y": 0.32, "score": 0.88},
            ],
            "attributes": {"model": payload.modelRef, "node": "mediapipe-cpu"},
        }
    ]
    return {
        "detections": detections,
        "providerLatencyMs": 27,
        "providerMeta": {"engine": "mediapipe", "node": "inference-node-mediapipe"},
    }
