from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="NearHome Inference Bridge", version="0.1.0")


class NodeCapability(BaseModel):
    capabilityId: str
    taskTypes: List[str] = Field(default_factory=list)
    models: List[str] = Field(default_factory=list)


class InferenceNode(BaseModel):
    nodeId: str
    tenantId: Optional[str] = None
    runtime: str
    transport: Literal["http", "grpc"] = "http"
    endpoint: str
    status: Literal["online", "degraded", "offline"] = "online"
    resources: Dict[str, int] = Field(default_factory=lambda: {"cpu": 1, "gpu": 0, "vramMb": 0})
    capabilities: List[NodeCapability] = Field(default_factory=list)
    models: List[str] = Field(default_factory=list)
    maxConcurrent: int = 1
    queueDepth: int = 0
    isDrained: bool = False
    lastHeartbeatAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    contractVersion: str = "1.0"


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
    provider: Literal["onprem_bento", "huggingface_space", "external_http"] = "onprem_bento"


class InferResponse(BaseModel):
    detections: List[Dict[str, Any]]
    providerLatencyMs: int
    providerMeta: Dict[str, Any] = Field(default_factory=dict)
    rawRef: Optional[str] = None


NODE_REGISTRY: Dict[str, InferenceNode] = {}


def _select_node(task_type: str, model_ref: str, tenant_id: str) -> Optional[InferenceNode]:
    candidates: List[InferenceNode] = []
    for node in NODE_REGISTRY.values():
        if node.status == "offline" or node.isDrained:
            continue
        if node.tenantId and node.tenantId != tenant_id:
            continue
        supports_task = any(task_type in cap.taskTypes for cap in node.capabilities) or not node.capabilities
        supports_model = model_ref in node.models or not node.models
        if supports_task and supports_model:
            candidates.append(node)
    if not candidates:
        return None
    return sorted(candidates, key=lambda n: (n.queueDepth, n.nodeId))[0]


@app.get("/health")
def health():
    return {"ok": True, "service": "inference-bridge", "nodes": len(NODE_REGISTRY)}


@app.post("/v1/nodes/register")
def register_node(node: InferenceNode):
    NODE_REGISTRY[node.nodeId] = node
    return {"data": node}


@app.post("/v1/nodes/heartbeat")
def heartbeat(node: InferenceNode):
    current = NODE_REGISTRY.get(node.nodeId)
    merged = node if current is None else current.model_copy(update=node.model_dump())
    merged.lastHeartbeatAt = datetime.now(timezone.utc)
    NODE_REGISTRY[node.nodeId] = merged
    return {"data": merged}


@app.get("/v1/nodes")
def list_nodes():
    return {"data": [node.model_dump(mode="json") for node in NODE_REGISTRY.values()], "total": len(NODE_REGISTRY)}


@app.post("/v1/nodes/{node_id}/drain")
def drain_node(node_id: str):
    node = NODE_REGISTRY.get(node_id)
    if not node:
        raise HTTPException(status_code=404, detail="node not found")
    node.isDrained = True
    return {"data": node}


@app.post("/v1/nodes/{node_id}/undrain")
def undrain_node(node_id: str):
    node = NODE_REGISTRY.get(node_id)
    if not node:
        raise HTTPException(status_code=404, detail="node not found")
    node.isDrained = False
    return {"data": node}


@app.post("/v1/infer")
async def infer(payload: InferRequest):
    if payload.provider != "onprem_bento":
        # Placeholder adapters for external providers in this increment.
        return InferResponse(
            detections=[
                {
                    "label": "person",
                    "confidence": 0.71,
                    "bbox": {"x": 0.22, "y": 0.16, "w": 0.2, "h": 0.4},
                    "attributes": {"provider": payload.provider}
                }
            ],
            providerLatencyMs=25,
            providerMeta={"provider": payload.provider, "mode": "mock"}
        )

    node = _select_node(payload.taskType, payload.modelRef, payload.tenantId)
    if not node:
        raise HTTPException(status_code=503, detail="no compatible node available")
    if node.transport != "http":
        raise HTTPException(status_code=501, detail="grpc transport not implemented in bridge v1")

    endpoint = node.endpoint.rstrip("/")
    async with httpx.AsyncClient(timeout=max(1, payload.deadlineMs / 1000)) as client:
        response = await client.post(f"{endpoint}/v1/infer", json=payload.model_dump(mode="json"))
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"node inference failed: {response.text}")
        body = response.json()

    return InferResponse(
        detections=body.get("detections", []),
        providerLatencyMs=int(body.get("providerLatencyMs", 0)),
        providerMeta={"nodeId": node.nodeId, **body.get("providerMeta", {})},
        rawRef=body.get("rawRef"),
    )
