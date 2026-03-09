from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI
from pydantic import BaseModel, Field

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("nearhome.inference-node-mediapipe")

NODE_ID = os.environ.get("NODE_ID", "node-mediapipe-1")
NODE_RUNTIME = os.environ.get("NODE_RUNTIME", "mediapipe")
NODE_TRANSPORT = os.environ.get("NODE_TRANSPORT", "http")
NODE_ENDPOINT = os.environ.get("NODE_ENDPOINT", "http://inference-node-mediapipe:8092")
NODE_TENANT_ID = os.environ.get("NODE_TENANT_ID", "").strip() or None
NODE_TENANT_IDS = sorted(
    set([x.strip() for x in os.environ.get("NODE_TENANT_IDS", "").split(",") if x.strip()])
)
NODE_CONTRACT_VERSION = os.environ.get("NODE_CONTRACT_VERSION", "1.0")
NODE_MAX_CONCURRENT = max(1, int(os.environ.get("NODE_MAX_CONCURRENT", "2")))
NODE_RESOURCES = {
    "cpu": max(0, int(os.environ.get("NODE_RESOURCES_CPU", "4"))),
    "gpu": max(0, int(os.environ.get("NODE_RESOURCES_GPU", "0"))),
    "vramMb": max(0, int(os.environ.get("NODE_RESOURCES_VRAM_MB", "0"))),
}
NODE_TASK_TYPES = [x.strip() for x in os.environ.get("NODE_TASK_TYPES", "pose_estimation,action_recognition").split(",") if x.strip()]
NODE_MODELS = [x.strip() for x in os.environ.get("NODE_MODELS", "mediapipe_pose@0.10.0").split(",") if x.strip()]
NODE_HEARTBEAT_INTERVAL_MS = max(2000, int(os.environ.get("NODE_HEARTBEAT_INTERVAL_MS", "10000")))
NODE_REFRESH_MARGIN_SECONDS = max(30, int(os.environ.get("NODE_REFRESH_MARGIN_SECONDS", "60")))
INFERENCE_BRIDGE_URL = os.environ.get("INFERENCE_BRIDGE_URL", "http://inference-bridge:8090").rstrip("/")
NODE_ENROLLMENT_TOKEN = os.environ.get("NODE_ENROLLMENT_TOKEN", "").strip()
NODE_AUTH_ADMIN_SECRET = os.environ.get("NODE_AUTH_ADMIN_SECRET", "").strip()
NODE_ENROLLMENT_TTL_SECONDS = max(60, int(os.environ.get("NODE_ENROLLMENT_TTL_SECONDS", "600")))

app = FastAPI(title="NearHome Inference Node MediaPipe", version="0.2.0")


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


class NodeAgentState:
    def __init__(self) -> None:
        self.access_token: Optional[str] = None
        self.refresh_token: Optional[str] = None
        self.access_expires_at: Optional[datetime] = None
        self.registered = False
        self.last_error: Optional[str] = None


agent_state = NodeAgentState()
agent_task: Optional[asyncio.Task[None]] = None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_expiry(value: Any) -> datetime:
    if isinstance(value, str):
        normalized = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return _utc_now() + timedelta(minutes=10)


def _node_payload() -> Dict[str, Any]:
    return {
        "nodeId": NODE_ID,
        "tenantId": NODE_TENANT_ID,
        "tenantIds": NODE_TENANT_IDS,
        "runtime": NODE_RUNTIME,
        "transport": NODE_TRANSPORT,
        "endpoint": NODE_ENDPOINT,
        "status": "online",
        "resources": NODE_RESOURCES,
        "capabilities": [{"capabilityId": f"{NODE_RUNTIME}-default", "taskTypes": NODE_TASK_TYPES, "models": NODE_MODELS}],
        "models": NODE_MODELS,
        "maxConcurrent": NODE_MAX_CONCURRENT,
        "queueDepth": 0,
        "isDrained": False,
        "contractVersion": NODE_CONTRACT_VERSION,
    }


async def _request_enrollment_token(client: httpx.AsyncClient) -> str:
    if NODE_ENROLLMENT_TOKEN:
        return NODE_ENROLLMENT_TOKEN
    if not NODE_AUTH_ADMIN_SECRET:
        raise RuntimeError("NODE_ENROLLMENT_TOKEN or NODE_AUTH_ADMIN_SECRET is required for node bootstrap")
    enrollment_scope = NODE_TENANT_ID or (NODE_TENANT_IDS[0] if len(NODE_TENANT_IDS) == 1 else "*")
    payload: Dict[str, Any] = {"nodeId": NODE_ID, "tenantScope": enrollment_scope, "ttlSeconds": NODE_ENROLLMENT_TTL_SECONDS}
    response = await client.post(
        f"{INFERENCE_BRIDGE_URL}/internal/nodes/enrollment-tokens",
        json=payload,
        headers={"x-node-auth-admin-secret": NODE_AUTH_ADMIN_SECRET},
    )
    response.raise_for_status()
    body = response.json()
    token = body.get("data", {}).get("enrollmentToken")
    if not token:
        raise RuntimeError("inference bridge did not return enrollment token")
    return str(token)


async def _enroll(client: httpx.AsyncClient) -> None:
    enrollment_token = await _request_enrollment_token(client)
    response = await client.post(
        f"{INFERENCE_BRIDGE_URL}/v1/nodes/enroll",
        json={"nodeId": NODE_ID, "enrollmentToken": enrollment_token},
    )
    response.raise_for_status()
    body = response.json().get("data", {})
    agent_state.access_token = body.get("nodeAccessToken")
    agent_state.refresh_token = body.get("refreshToken")
    agent_state.access_expires_at = _parse_expiry(body.get("expiresAt"))
    agent_state.registered = False
    logger.info("node enrolled: node_id=%s", NODE_ID)


async def _refresh_access_token(client: httpx.AsyncClient) -> None:
    if not agent_state.refresh_token:
        raise RuntimeError("refresh token unavailable")
    response = await client.post(
        f"{INFERENCE_BRIDGE_URL}/v1/nodes/token/refresh",
        json={"nodeId": NODE_ID, "refreshToken": agent_state.refresh_token},
    )
    response.raise_for_status()
    body = response.json().get("data", {})
    agent_state.access_token = body.get("nodeAccessToken")
    agent_state.access_expires_at = _parse_expiry(body.get("expiresAt"))
    logger.info("node token refreshed: node_id=%s", NODE_ID)


async def _register_node(client: httpx.AsyncClient) -> None:
    if not agent_state.access_token:
        raise RuntimeError("access token unavailable")
    response = await client.post(
        f"{INFERENCE_BRIDGE_URL}/v1/nodes/register",
        json=_node_payload(),
        headers={"authorization": f"Bearer {agent_state.access_token}"},
    )
    response.raise_for_status()
    agent_state.registered = True
    logger.info("node registered: node_id=%s endpoint=%s", NODE_ID, NODE_ENDPOINT)


async def _heartbeat(client: httpx.AsyncClient) -> None:
    if not agent_state.access_token:
        raise RuntimeError("access token unavailable")
    response = await client.post(
        f"{INFERENCE_BRIDGE_URL}/v1/nodes/heartbeat",
        json={"nodeId": NODE_ID, "status": "online", "queueDepth": 0, "resources": NODE_RESOURCES},
        headers={"authorization": f"Bearer {agent_state.access_token}"},
    )
    if response.status_code in (401, 403):
        agent_state.registered = False
        raise RuntimeError(f"heartbeat auth rejected status={response.status_code}")
    if response.status_code == 404:
        agent_state.registered = False
        raise RuntimeError("heartbeat rejected: node not registered")
    response.raise_for_status()


async def _agent_loop() -> None:
    logger.info("node agent started: node_id=%s bridge=%s", NODE_ID, INFERENCE_BRIDGE_URL)
    async with httpx.AsyncClient(timeout=10.0) as client:
        while True:
            try:
                now = _utc_now()
                if not agent_state.access_token:
                    await _enroll(client)
                if agent_state.access_expires_at and agent_state.access_expires_at <= now + timedelta(seconds=NODE_REFRESH_MARGIN_SECONDS):
                    await _refresh_access_token(client)
                if not agent_state.registered:
                    await _register_node(client)
                await _heartbeat(client)
                agent_state.last_error = None
                await asyncio.sleep(NODE_HEARTBEAT_INTERVAL_MS / 1000)
            except asyncio.CancelledError:
                logger.info("node agent stopped: node_id=%s", NODE_ID)
                raise
            except Exception as exc:  # noqa: BLE001
                agent_state.last_error = str(exc)
                logger.warning("node agent loop failed: %s", exc)
                if "refresh token unavailable" in str(exc).lower():
                    agent_state.access_token = None
                    agent_state.registered = False
                await asyncio.sleep(3)


@app.on_event("startup")
async def startup_event() -> None:
    global agent_task
    if agent_task is None:
        agent_task = asyncio.create_task(_agent_loop())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    global agent_task
    if agent_task is not None:
        agent_task.cancel()
        try:
            await agent_task
        except asyncio.CancelledError:
            pass
        agent_task = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "inference-node-mediapipe",
        "node": {
            "nodeId": NODE_ID,
            "registered": agent_state.registered,
            "lastError": agent_state.last_error,
            "bridge": INFERENCE_BRIDGE_URL,
        },
    }


@app.get("/v1/capabilities")
def capabilities():
    return {"data": {"taskTypes": NODE_TASK_TYPES, "models": NODE_MODELS}}


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
            "attributes": {"model": payload.modelRef, "node": NODE_ID},
        }
    ]
    return {
        "detections": detections,
        "providerLatencyMs": 27,
        "providerMeta": {"engine": "mediapipe", "node": NODE_ID},
    }
