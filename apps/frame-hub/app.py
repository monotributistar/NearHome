"""NearHome Frame Hub: cheap motion gate, policy execution and frame correlation.

The hub is the only component that owns frames after capture. It runs a low-cost
per-camera motion gate, persists only triggered evidence, and sends the same
encoded frame to the bridge for every enabled policy pipeline.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, Optional

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("nearhome.frame-hub")

FRAME_DIR = Path(os.environ.get("FRAME_HUB_FRAME_DIR", "/data/frames"))
FRAME_TTL_SECONDS = max(10, int(os.environ.get("FRAME_HUB_FRAME_TTL_SECONDS", "120")))
MAX_FRAME_BYTES = max(1_024, int(os.environ.get("FRAME_HUB_MAX_FRAME_BYTES", str(12 * 1024 * 1024))))
MAX_FRAMES_PER_CAMERA = max(1, int(os.environ.get("FRAME_HUB_MAX_FRAMES_PER_CAMERA", "100")))
MAX_CONCURRENT_PIPELINES = max(1, int(os.environ.get("FRAME_HUB_MAX_CONCURRENT_PIPELINES", "8")))
MOTION_WIDTH = max(64, int(os.environ.get("FRAME_HUB_MOTION_WIDTH", "320")))
MOTION_THRESHOLD = float(os.environ.get("FRAME_HUB_MOTION_THRESHOLD", "0.025"))
MOTION_COOLDOWN_SECONDS = max(0.0, float(os.environ.get("FRAME_HUB_MOTION_COOLDOWN_SECONDS", "0.75")))
MOTION_WARMUP_FRAMES = max(0, int(os.environ.get("FRAME_HUB_MOTION_WARMUP_FRAMES", "20")))
INFERENCE_BRIDGE_URL = os.environ.get("INFERENCE_BRIDGE_URL", "http://inference-bridge:8090").rstrip("/")
EVENT_GATEWAY_URL = os.environ.get("EVENT_GATEWAY_URL", "").rstrip("/")
EVENT_PUBLISH_SECRET = os.environ.get("EVENT_PUBLISH_SECRET", "")
PROFILE_API_URL = os.environ.get("FRAME_HUB_PROFILE_API_URL", "").rstrip("/")
PROFILE_API_TOKEN = os.environ.get("FRAME_HUB_PROFILE_API_TOKEN", "")
PROFILE_CACHE_SECONDS = max(1, int(os.environ.get("FRAME_HUB_PROFILE_CACHE_SECONDS", "30")))
DEFAULT_MODEL_REF = os.environ.get("FRAME_HUB_DEFAULT_MODEL_REF", "yolo11n@1.0")
DEFAULT_MAX_INFLIGHT_PER_PIPELINE = max(1, int(os.environ.get("FRAME_HUB_MAX_INFLIGHT_PER_PIPELINE", "1")))

try:
    STATIC_PROFILES = json.loads(os.environ.get("FRAME_HUB_CAMERA_PROFILES_JSON", "{}"))
    if not isinstance(STATIC_PROFILES, dict):
        STATIC_PROFILES = {}
except json.JSONDecodeError:
    logger.warning("FRAME_HUB_CAMERA_PROFILES_JSON is invalid JSON; ignoring it")
    STATIC_PROFILES = {}

SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9_.-]+")


def _safe_segment(value: str) -> str:
    cleaned = SAFE_SEGMENT.sub("_", value).strip("._")
    return cleaned or "unknown"


def _default_profile() -> Dict[str, Any]:
    return {
        "pipelines": [{
            "pipelineId": "default-object-detection",
            "provider": "yolo",
            "taskType": "object_detection",
            "quality": "fast",
            "enabled": True,
            "schedule": {"mode": "realtime", "frameStride": 1},
            "thresholds": {"confidence": 0.25, "maxDet": 20},
        }]
    }


def _depends_on(pipeline: Dict[str, Any]) -> list[str]:
    outputs = pipeline.get("outputs") if isinstance(pipeline.get("outputs"), dict) else {}
    value = outputs.get("dependsOn")
    if isinstance(value, str) and value:
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    return []


def _qualified_detections(pipeline: Dict[str, Any], runs: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    outputs = pipeline.get("outputs") if isinstance(pipeline.get("outputs"), dict) else {}
    labels = outputs.get("gateLabels", [])
    allowed_labels = set(labels) if isinstance(labels, list) else set()
    min_confidence = float(outputs.get("minConfidence", 0.0))
    detections = []
    for run in runs:
        for detection in run.get("detections", []):
            if not isinstance(detection, dict):
                continue
            if allowed_labels and detection.get("label") not in allowed_labels:
                continue
            if float(detection.get("confidence", 0.0)) < min_confidence:
                continue
            detections.append(detection)
    return detections


def _crop_frame(image_bytes: bytes, bbox: Dict[str, Any], padding_ratio: float) -> Optional[bytes]:
    """Crop an expensive downstream input only after a qualifying parent detection."""
    try:
        image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return None
        x, y, w, h = (float(bbox[key]) for key in ("x", "y", "w", "h"))
        padding_x, padding_y = w * padding_ratio, h * padding_ratio
        left, top = max(0, int(x - padding_x)), max(0, int(y - padding_y))
        right, bottom = min(image.shape[1], int(x + w + padding_x)), min(image.shape[0], int(y + h + padding_y))
        if right <= left or bottom <= top:
            return None
        ok, encoded = cv2.imencode(".jpg", image[top:bottom, left:right], [cv2.IMWRITE_JPEG_QUALITY, 88])
        return encoded.tobytes() if ok else None
    except (KeyError, TypeError, ValueError):
        return None


@dataclass
class FrameRecord:
    tenant_id: str
    camera_id: str
    pts: int
    path: Path
    width: int
    height: int
    captured_at: str
    motion_pct: float


@dataclass
class CameraMotionGate:
    subtractor: Any = field(default_factory=lambda: cv2.createBackgroundSubtractorMOG2(
        history=300, varThreshold=32, detectShadows=False
    ))
    frames_seen: int = 0
    last_trigger_at: float = -1_000_000.0

    def process(self, image_bytes: bytes) -> tuple[bool, float]:
        image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise ValueError("uploaded image could not be decoded")
        if image.shape[1] > MOTION_WIDTH:
            scale = MOTION_WIDTH / image.shape[1]
            image = cv2.resize(image, (MOTION_WIDTH, max(1, int(image.shape[0] * scale))))
        mask = self.subtractor.apply(image)
        self.frames_seen += 1
        motion_pct = float(np.count_nonzero(mask)) / mask.size
        if self.frames_seen <= MOTION_WARMUP_FRAMES:
            return False, motion_pct
        if motion_pct < MOTION_THRESHOLD:
            return False, motion_pct
        now = time.monotonic()
        if now - self.last_trigger_at < MOTION_COOLDOWN_SECONDS:
            return False, motion_pct
        self.last_trigger_at = now
        return True, motion_pct


@dataclass
class Track:
    track_id: str
    label: str
    bbox: Dict[str, float]
    first_seen_at: float
    last_seen_at: float
    emitted_rules: set[str] = field(default_factory=set)


def _iou(left: Dict[str, Any], right: Dict[str, Any]) -> float:
    try:
        lx1, ly1 = float(left["x"]), float(left["y"])
        lx2, ly2 = lx1 + float(left["w"]), ly1 + float(left["h"])
        rx1, ry1 = float(right["x"]), float(right["y"])
        rx2, ry2 = rx1 + float(right["w"]), ry1 + float(right["h"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    intersection = max(0.0, min(lx2, rx2) - max(lx1, rx1)) * max(0.0, min(ly2, ry2) - max(ly1, ry1))
    union = (lx2 - lx1) * (ly2 - ly1) + (rx2 - rx1) * (ry2 - ry1) - intersection
    return intersection / union if union > 0 else 0.0


class SemanticTracker:
    """Small IoU tracker used only for temporal rules, not detector identity."""
    def __init__(self) -> None:
        self._tracks: Dict[str, list[Track]] = {}

    def update(self, camera_id: str, detections: list[Dict[str, Any]], rules: Dict[str, Any]) -> list[Dict[str, Any]]:
        semantic = rules.get("semantic") if isinstance(rules.get("semantic"), dict) else {}
        dwell_seconds = semantic.get("dwellSeconds") if isinstance(semantic.get("dwellSeconds"), dict) else {}
        loiter_seconds = semantic.get("personLoiteringSeconds")
        if not dwell_seconds and not isinstance(loiter_seconds, (int, float)):
            return []

        now = time.time()
        tracks = self._tracks.setdefault(camera_id, [])
        tracks[:] = [track for track in tracks if now - track.last_seen_at <= 30]
        events: list[Dict[str, Any]] = []
        for detection in detections:
            label = detection.get("label")
            bbox = detection.get("bbox")
            if not isinstance(label, str) or not isinstance(bbox, dict):
                continue
            candidates = [track for track in tracks if track.label == label]
            matched = max(candidates, key=lambda track: _iou(track.bbox, bbox), default=None)
            if matched is None or _iou(matched.bbox, bbox) < 0.3:
                matched = Track(track_id=str(uuid.uuid4()), label=label, bbox=bbox, first_seen_at=now, last_seen_at=now)
                tracks.append(matched)
            else:
                matched.bbox = bbox
                matched.last_seen_at = now

            duration_seconds = int(now - matched.first_seen_at)
            threshold = dwell_seconds.get(label)
            rule_id = f"dwell:{label}"
            if isinstance(threshold, (int, float)) and duration_seconds >= threshold and rule_id not in matched.emitted_rules:
                matched.emitted_rules.add(rule_id)
                events.append({
                    "eventType": "presence.dwell", "label": label, "trackId": matched.track_id,
                    "durationSeconds": duration_seconds, "thresholdSeconds": threshold, "bbox": bbox,
                })
            if label == "person" and isinstance(loiter_seconds, (int, float)) and duration_seconds >= loiter_seconds:
                rule_id = "person:loitering"
                if rule_id not in matched.emitted_rules:
                    matched.emitted_rules.add(rule_id)
                    events.append({
                        "eventType": "person.loitering", "label": label, "trackId": matched.track_id,
                        "durationSeconds": duration_seconds, "thresholdSeconds": loiter_seconds, "bbox": bbox,
                    })
        return events


class ProfileCache:
    def __init__(self) -> None:
        self._cache: Dict[tuple[str, str], tuple[float, Dict[str, Any]]] = {}

    async def get(self, tenant_id: str, camera_id: str) -> Dict[str, Any]:
        key = (tenant_id, camera_id)
        cached = self._cache.get(key)
        now = time.monotonic()
        if cached and now - cached[0] < PROFILE_CACHE_SECONDS:
            return cached[1]

        profile = STATIC_PROFILES.get(camera_id) or STATIC_PROFILES.get(f"{tenant_id}/{camera_id}")
        if not profile and PROFILE_API_URL and PROFILE_API_TOKEN:
            try:
                async with httpx.AsyncClient(timeout=3.0) as client:
                    response = await client.get(
                        f"{PROFILE_API_URL}/cameras/{camera_id}/profile",
                        headers={"authorization": f"Bearer {PROFILE_API_TOKEN}", "x-tenant-id": tenant_id},
                    )
                    response.raise_for_status()
                    profile_row = response.json().get("data")
                    if isinstance(profile_row, dict):
                        detection_profile = profile_row.get("detectionProfile")
                        if isinstance(detection_profile, dict):
                            profile = {**detection_profile, "rulesProfile": profile_row.get("rulesProfile", {})}
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("profile fetch failed for %s: %s", camera_id, exc)
        if not isinstance(profile, dict):
            profile = _default_profile()
        self._cache[key] = (now, profile)
        return profile


class FrameHub:
    def __init__(self) -> None:
        self.gates: Dict[str, CameraMotionGate] = {}
        self.frames: Dict[str, Deque[FrameRecord]] = {}
        self.runs: Deque[Dict[str, Any]] = deque(maxlen=500)
        self.profile_cache = ProfileCache()
        self.semantic_tracker = SemanticTracker()
        self.pipeline_semaphore = asyncio.Semaphore(MAX_CONCURRENT_PIPELINES)
        self.inflight: Dict[tuple[str, str], int] = {}
        self.pipeline_frame_counts: Dict[tuple[str, str], int] = {}
        self.pipeline_latency_ms: Dict[tuple[str, str], float] = {}
        self.total_frames = 0
        self.motion_frames = 0
        self.skipped_frames = 0
        self.pipeline_runs = 0

    def gate(self, camera_id: str) -> CameraMotionGate:
        return self.gates.setdefault(camera_id, CameraMotionGate())

    def store(self, record: FrameRecord) -> None:
        records = self.frames.setdefault(record.camera_id, deque())
        records.append(record)
        while len(records) > MAX_FRAMES_PER_CAMERA:
            expired = records.popleft()
            expired.path.unlink(missing_ok=True)
        self.cleanup(record.camera_id)

    def cleanup(self, camera_id: Optional[str] = None) -> None:
        threshold = time.time() - FRAME_TTL_SECONDS
        camera_ids = [camera_id] if camera_id else list(self.frames)
        for current_camera_id in camera_ids:
            records = self.frames.get(current_camera_id, deque())
            while records:
                try:
                    is_expired = records[0].path.stat().st_mtime < threshold
                except FileNotFoundError:
                    is_expired = True
                if not is_expired:
                    break
                expired = records.popleft()
                expired.path.unlink(missing_ok=True)

    def frame_path(self, camera_id: str, pts: int) -> Path:
        return FRAME_DIR / _safe_segment(camera_id) / f"{pts}.jpg"

    async def run_pipelines(self, record: FrameRecord, image_bytes: bytes) -> None:
        profile = await self.profile_cache.get(record.tenant_id, record.camera_id)
        pipelines = profile.get("pipelines") if isinstance(profile, dict) else None
        if not isinstance(pipelines, list) or not pipelines:
            pipelines = _default_profile()["pipelines"]
        valid_pipelines = [pipeline for pipeline in pipelines if isinstance(pipeline, dict)]
        base_pipelines = [pipeline for pipeline in valid_pipelines if not _depends_on(pipeline)]
        dependent_pipelines = [pipeline for pipeline in valid_pipelines if _depends_on(pipeline)]
        results = [result for result in await asyncio.gather(*[
            self.run_pipeline(record, image_bytes, pipeline) for pipeline in base_pipelines
        ]) if result is not None]

        by_pipeline = {run["pipelineId"]: [run] for run in results}
        for pipeline in dependent_pipelines:
            parent_runs = [run for parent_id in _depends_on(pipeline) for run in by_pipeline.get(parent_id, [])]
            parents = _qualified_detections(pipeline, parent_runs)
            if not parents:
                continue
            outputs = pipeline.get("outputs") if isinstance(pipeline.get("outputs"), dict) else {}
            use_parent_crop = bool(outputs.get("cropFromParent", True))
            padding_ratio = max(0.0, float(outputs.get("cropPaddingRatio", 0.15)))
            child_tasks = []
            for parent in parents:
                crop = _crop_frame(image_bytes, parent.get("bbox", {}), padding_ratio) if use_parent_crop else image_bytes
                if crop:
                    child_tasks.append(self.run_pipeline(record, crop, pipeline, parent_detection=parent))
            child_results = [result for result in await asyncio.gather(*child_tasks) if result is not None]
            results.extend(child_results)
            if child_results:
                by_pipeline.setdefault(str(pipeline.get("pipelineId") or pipeline.get("provider") or "unnamed"), []).extend(child_results)

        if results:
            detections = [detection for run in results for detection in run.get("detections", []) if isinstance(detection, dict)]
            rules = profile.get("rulesProfile") if isinstance(profile.get("rulesProfile"), dict) else {}
            semantic_events = self.semantic_tracker.update(record.camera_id, detections, rules)
            await self.publish_batch(record, results, semantic_events)

    async def run_pipeline(
        self,
        record: FrameRecord,
        image_bytes: bytes,
        pipeline: Dict[str, Any],
        parent_detection: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        if not pipeline.get("enabled", True):
            return None
        pipeline_id = str(pipeline.get("pipelineId") or pipeline.get("provider") or "unnamed")
        key = (record.camera_id, pipeline_id)
        schedule = pipeline.get("schedule") if isinstance(pipeline.get("schedule"), dict) else {}
        stride = max(1, int(schedule.get("frameStride", 1)))
        frame_count = self.pipeline_frame_counts.get(key, 0) + 1
        self.pipeline_frame_counts[key] = frame_count
        if frame_count % stride != 0:
            self.skipped_frames += 1
            return None
        if self.inflight.get(key, 0) >= DEFAULT_MAX_INFLIGHT_PER_PIPELINE:
            self.skipped_frames += 1
            return None

        self.inflight[key] = self.inflight.get(key, 0) + 1
        self.pipeline_runs += 1
        started = time.monotonic()
        run: Dict[str, Any] = {
            "runId": str(uuid.uuid4()), "cameraId": record.camera_id, "tenantId": record.tenant_id,
            "pts": record.pts, "pipelineId": pipeline_id, "status": "running", "detections": [],
        }
        if parent_detection is not None:
            run["parentDetection"] = parent_detection
        try:
            async with self.pipeline_semaphore:
                thresholds = pipeline.get("thresholds") if isinstance(pipeline.get("thresholds"), dict) else {}
                model_ref = str(pipeline.get("modelRef") or thresholds.get("modelRef") or DEFAULT_MODEL_REF)
                task_type = str(pipeline.get("taskType") or "object_detection")
                timeout_ms = max(100, int(thresholds.get("timeoutMs", 5_000)))
                payload = {
                    "requestId": run["runId"], "jobId": run["runId"], "tenantId": record.tenant_id,
                    "cameraId": record.camera_id, "taskType": task_type, "modelRef": model_ref,
                    "mediaRef": {"dataBase64": base64.b64encode(image_bytes).decode("ascii"), "contentType": "image/jpeg", "filename": f"{record.pts}.jpg"},
                    "thresholds": thresholds, "deadlineMs": timeout_ms, "priority": 5, "provider": "onprem_bento",
                }
                async with httpx.AsyncClient(timeout=timeout_ms / 1000) as client:
                    response = await client.post(f"{INFERENCE_BRIDGE_URL}/v1/infer", json=payload)
                    response.raise_for_status()
                    result = response.json()
                run["detections"] = result.get("detections", [])
                run["providerLatencyMs"] = result.get("providerLatencyMs", 0)
                run["providerMeta"] = result.get("providerMeta", {})
                run["status"] = "ok"
        except (httpx.HTTPError, ValueError) as exc:
            run["status"] = "error"
            run["error"] = str(exc)
            logger.warning("pipeline %s failed for %s: %s", pipeline_id, record.camera_id, exc)
        finally:
            latency_ms = round((time.monotonic() - started) * 1000)
            run["latencyMs"] = latency_ms
            self.pipeline_latency_ms[key] = latency_ms
            self.inflight[key] = max(0, self.inflight.get(key, 1) - 1)
            self.runs.append(run)
        return run

    async def publish_batch(self, record: FrameRecord, runs: list[Dict[str, Any]], semantic_events: list[Dict[str, Any]]) -> None:
        if not EVENT_GATEWAY_URL or not EVENT_PUBLISH_SECRET:
            return
        detections = []
        for run in runs:
            for detection in run.get("detections", []):
                if isinstance(detection, dict):
                    detections.append({"pipelineId": run["pipelineId"], **detection})
        event = {
            "eventType": "detection.batch", "tenantId": record.tenant_id, "cameraId": record.camera_id,
            "correlationId": f"{record.camera_id}:{record.pts}", "occurredAt": datetime.now(timezone.utc).isoformat(),
            "payload": {
                "pts": record.pts, "frameUrl": f"/v1/frames/{record.camera_id}/{record.pts}.jpg",
                "motionPct": record.motion_pct, "detections": detections, "pipelines": runs,
                "latencyMs": {run["pipelineId"]: run.get("latencyMs", 0) for run in runs},
                "semanticEvents": semantic_events,
            },
        }
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.post(f"{EVENT_GATEWAY_URL}/internal/events/publish", json=event, headers={"x-event-publish-secret": EVENT_PUBLISH_SECRET})
                for semantic_event in semantic_events:
                    await client.post(
                        f"{EVENT_GATEWAY_URL}/internal/events/publish",
                        json={
                            "eventType": semantic_event["eventType"], "tenantId": record.tenant_id,
                            "cameraId": record.camera_id, "correlationId": f"{record.camera_id}:{record.pts}",
                            "payload": {"pts": record.pts, "frameUrl": f"/v1/frames/{record.camera_id}/{record.pts}.jpg", **semantic_event},
                        },
                        headers={"x-event-publish-secret": EVENT_PUBLISH_SECRET},
                    )
        except httpx.HTTPError as exc:
            logger.warning("event publish failed: %s", exc)


hub = FrameHub()
app = FastAPI(title="NearHome Frame Hub", version="0.1.0")


class RunResponse(BaseModel):
    runs: list[Dict[str, Any]] = Field(default_factory=list)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True, "service": "frame-hub", "metrics": {
            "totalFrames": hub.total_frames, "motionFrames": hub.motion_frames, "skippedFrames": hub.skipped_frames,
            "pipelineRuns": hub.pipeline_runs, "trackedCameras": len(hub.gates), "storedFrames": sum(len(items) for items in hub.frames.values()),
        },
    }


@app.get("/v1/runs", response_model=RunResponse)
def runs(cameraId: Optional[str] = None, limit: int = 50) -> RunResponse:
    selected = list(hub.runs)
    if cameraId:
        selected = [run for run in selected if run["cameraId"] == cameraId]
    return RunResponse(runs=selected[-max(1, min(limit, 200)):])


@app.get("/v1/frames/{camera_id}/{pts}.jpg")
def get_frame(camera_id: str, pts: int) -> FileResponse:
    path = hub.frame_path(camera_id, pts)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="frame not found or expired")
    return FileResponse(path, media_type="image/jpeg")


@app.post("/v1/frames")
async def ingest_frame(
    image: UploadFile = File(...),
    tenantId: str = Form(...),
    cameraId: str = Form(...),
    pts: int = Form(...),
    capturedAt: str = Form(""),
) -> Dict[str, Any]:
    if not tenantId or not cameraId:
        raise HTTPException(status_code=422, detail="tenantId and cameraId are required")
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="image must have an image content type")
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=422, detail="image is empty")
    if len(image_bytes) > MAX_FRAME_BYTES:
        raise HTTPException(status_code=413, detail="image exceeds configured size limit")

    hub.total_frames += 1
    try:
        triggered, motion_pct = hub.gate(cameraId).process(image_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not triggered:
        return {"accepted": False, "reason": "motion_gate", "motionPct": round(motion_pct, 5)}

    hub.motion_frames += 1
    path = hub.frame_path(cameraId, pts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(image_bytes)
    record = FrameRecord(
        tenant_id=tenantId, camera_id=cameraId, pts=pts, path=path, width=0, height=0,
        captured_at=capturedAt or datetime.now(timezone.utc).isoformat(), motion_pct=motion_pct,
    )
    hub.store(record)
    asyncio.create_task(hub.run_pipelines(record, image_bytes))
    return {"accepted": True, "pts": pts, "motionPct": round(motion_pct, 5), "frameUrl": f"/v1/frames/{cameraId}/{pts}.jpg"}
