"""FastAPI wrapper for change-detector service.

Provides health check, start/stop pipeline, and status endpoints.
Runs on port 8085 by default.
"""

from __future__ import annotations

import logging
import os
from threading import Thread
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .pipeline import Pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
logger = logging.getLogger("change-detector")

app = FastAPI(title="NearHome Change Detector", version="0.1.0")

# ─── Config from env ────────────────────────────────────────────────────

DEFAULT_RTSP = os.environ.get("CHANGE_RTSP_URL", "")
DEFAULT_TENANT = os.environ.get("CHANGE_TENANT_ID", "poc-tenant")
DEFAULT_CAMERA = os.environ.get("CHANGE_CAMERA_ID", "poc-camera")
INFERENCE_URL = os.environ.get(
    "CHANGE_INFERENCE_URL", "http://localhost:8090/v1/infer/hf/yolo"
)
FRAME_WIDTH = int(os.environ.get("CHANGE_FRAME_WIDTH", "640"))
FRAME_HEIGHT = int(os.environ.get("CHANGE_FRAME_HEIGHT", "480"))
FRAME_SKIP = int(os.environ.get("CHANGE_FRAME_SKIP", "3"))
MOTION_THRESHOLD = float(os.environ.get("CHANGE_MOTION_THRESHOLD", "0.05"))


# ─── Models ──────────────────────────────────────────────────────────────

class StartRequest(BaseModel):
    rtspUrl: str
    tenantId: str = DEFAULT_TENANT
    cameraId: str = DEFAULT_CAMERA


class StatusResponse(BaseModel):
    running: bool
    rtspUrl: Optional[str] = None
    tenantId: Optional[str] = None
    cameraId: Optional[str] = None
    totalFrames: int = 0
    motionFrames: int = 0
    detectorWarmedUp: bool = False


# ─── State ────────────────────────────────────────────────────────────────

_pipeline: Optional[Pipeline] = None
_thread: Optional[Thread] = None


# ─── Routes ───────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "change-detector",
        "pipelineRunning": _pipeline is not None and _pipeline.status["running"],
    }


@app.get("/status", response_model=StatusResponse)
def status():
    if _pipeline is None:
        return StatusResponse(running=False)
    s = _pipeline.status
    return StatusResponse(
        running=s["running"],
        rtspUrl=s["rtspUrl"],
        tenantId=s["tenantId"],
        cameraId=s["cameraId"],
        totalFrames=s["totalFrames"],
        motionFrames=s["motionFrames"],
        detectorWarmedUp=s["detectorWarmedUp"],
    )


@app.post("/start")
def start(req: StartRequest):
    global _pipeline, _thread

    if _pipeline is not None and _pipeline.status["running"]:
        raise HTTPException(409, "Pipeline already running")

    rtsp = req.rtspUrl or DEFAULT_RTSP
    if not rtsp:
        raise HTTPException(400, "No RTSP URL provided")

    _pipeline = Pipeline(
        rtsp_url=rtsp,
        tenant_id=req.tenantId,
        camera_id=req.cameraId,
        inference_url=INFERENCE_URL,
        frame_width=FRAME_WIDTH,
        frame_height=FRAME_HEIGHT,
        frame_skip=FRAME_SKIP,
        motion_threshold=MOTION_THRESHOLD,
    )

    _thread = Thread(target=_pipeline.start, daemon=True)
    _thread.start()

    logger.info("Pipeline started: %s → %s", rtsp, INFERENCE_URL)
    return {"status": "started", "rtspUrl": rtsp}


@app.post("/stop")
def stop():
    global _pipeline, _thread

    if _pipeline is None:
        return {"status": "not_running"}

    _pipeline.stop()
    _pipeline = None
    _thread = None

    return {"status": "stopped"}


# ─── Entrypoint ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CHANGE_PORT", "8085"))
    logger.info("Starting change-detector on :%d", port)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
