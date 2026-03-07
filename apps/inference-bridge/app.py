from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Literal, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, Field

app = FastAPI(title="NearHome Inference Bridge", version="0.2.0")

JWT_SECRET = os.environ.get("NODE_AUTH_JWT_SECRET", "dev-node-auth-secret")
JWT_ISSUER = os.environ.get("NODE_AUTH_JWT_ISSUER", "nearhome-control-plane")
JWT_AUDIENCE = os.environ.get("NODE_AUTH_JWT_AUDIENCE", "inference-bridge")
ADMIN_SECRET = os.environ.get("NODE_AUTH_ADMIN_SECRET", "dev-node-auth-admin-secret")
NODE_TOKEN_TTL_SECONDS = max(60, int(os.environ.get("NODE_AUTH_TOKEN_TTL_SECONDS", "900")))
NODE_REFRESH_TTL_SECONDS = max(300, int(os.environ.get("NODE_AUTH_REFRESH_TTL_SECONDS", "86400")))
ENROLLMENT_TOKEN_TTL_SECONDS = max(60, int(os.environ.get("NODE_AUTH_ENROLLMENT_TTL_SECONDS", "600")))
NODE_HEARTBEAT_TTL_MS = max(5_000, int(os.environ.get("NODE_HEARTBEAT_TTL_MS", "60000")))


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


class HeartbeatRequest(BaseModel):
    nodeId: str
    status: Literal["online", "degraded", "offline"] = "online"
    queueDepth: Optional[int] = None
    resources: Optional[Dict[str, int]] = None


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


class EnrollmentTokenCreateRequest(BaseModel):
    nodeId: str
    tenantScope: Optional[str] = None
    ttlSeconds: Optional[int] = None


class NodeEnrollRequest(BaseModel):
    nodeId: str
    enrollmentToken: str
    nonce: Optional[str] = None
    csr: Optional[str] = None


class NodeRefreshRequest(BaseModel):
    nodeId: str
    refreshToken: str


class NodeRevokeRequest(BaseModel):
    reason: str = "manual_revoke"


class EnrollmentTokenEntry(BaseModel):
    nodeId: str
    tenantScope: str
    expiresAt: datetime
    used: bool = False
    createdAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class RefreshTokenEntry(BaseModel):
    nodeId: str
    tenantScope: str
    expiresAt: datetime
    revoked: bool = False
    createdAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class NodeAuthClaims(BaseModel):
    sub: str
    typ: Literal["node"]
    iss: str
    aud: str
    tenantScope: str
    caps: List[str] = Field(default_factory=list)
    exp: int
    iat: int
    jti: str


# Ensure Pydantic/FastAPI body adapters are fully resolved in dynamic loaders (tests/harness).
for _model in (
    NodeCapability,
    InferenceNode,
    HeartbeatRequest,
    InferRequest,
    InferResponse,
    EnrollmentTokenCreateRequest,
    NodeEnrollRequest,
    NodeRefreshRequest,
    NodeRevokeRequest,
    EnrollmentTokenEntry,
    RefreshTokenEntry,
    NodeAuthClaims,
):
    _model.model_rebuild(force=True, _types_namespace=globals())


NODE_REGISTRY: Dict[str, InferenceNode] = {}
ENROLLMENT_TOKENS: Dict[str, EnrollmentTokenEntry] = {}
REFRESH_TOKENS: Dict[str, RefreshTokenEntry] = {}
REVOKED_NODES: set[str] = set()


def _error(status_code: int, code: str, message: str, details: Optional[Dict[str, Any]] = None) -> HTTPException:
    payload: Dict[str, Any] = {"code": code, "message": message}
    if details:
        payload["details"] = details
    return HTTPException(status_code=status_code, detail=payload)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _from_b64url(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _create_node_access_token(node_id: str, tenant_scope: str) -> tuple[str, datetime]:
    issued_at = _now()
    expires_at = issued_at + timedelta(seconds=NODE_TOKEN_TTL_SECONDS)
    payload = {
        "sub": node_id,
        "typ": "node",
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "tenantScope": tenant_scope,
        "caps": [],
        "exp": int(expires_at.timestamp()),
        "iat": int(issued_at.timestamp()),
        "jti": secrets.token_hex(12),
    }
    header = {"alg": "HS256", "typ": "JWT"}
    header_part = _to_b64url(json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    payload_part = _to_b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signing_input = f"{header_part}.{payload_part}".encode("utf-8")
    signature = hmac.new(JWT_SECRET.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header_part}.{payload_part}.{_to_b64url(signature)}", expires_at


def _verify_node_access_token(token: str) -> NodeAuthClaims:
    parts = token.split(".")
    if len(parts) != 3:
        raise _error(401, "NODE_AUTH_INVALID", "node token format invalid")
    header_part, payload_part, signature_part = parts
    signing_input = f"{header_part}.{payload_part}".encode("utf-8")
    expected_sig = hmac.new(JWT_SECRET.encode("utf-8"), signing_input, hashlib.sha256).digest()
    provided_sig = _from_b64url(signature_part)
    if not hmac.compare_digest(expected_sig, provided_sig):
        raise _error(401, "NODE_AUTH_INVALID", "node token signature invalid")
    try:
        payload_raw = _from_b64url(payload_part).decode("utf-8")
        payload = json.loads(payload_raw)
        claims = NodeAuthClaims.model_validate(payload)
    except Exception:
        raise _error(401, "NODE_AUTH_INVALID", "node token payload invalid")
    if claims.iss != JWT_ISSUER:
        raise _error(401, "NODE_AUTH_INVALID", "node token issuer invalid")
    if claims.aud != JWT_AUDIENCE:
        raise _error(401, "NODE_AUTH_INVALID", "node token audience invalid")
    if claims.exp <= int(_now().timestamp()):
        raise _error(401, "NODE_AUTH_EXPIRED", "node token expired")
    if claims.sub in REVOKED_NODES:
        raise _error(403, "NODE_REVOKED", "node has been revoked", {"nodeId": claims.sub})
    return claims


def _require_admin_auth(x_node_auth_admin_secret: str | None = Header(default=None)) -> None:
    if x_node_auth_admin_secret != ADMIN_SECRET:
        raise _error(401, "UNAUTHORIZED", "invalid node auth admin secret")


def _require_node_auth(authorization: str | None = Header(default=None)) -> NodeAuthClaims:
    if not authorization:
        raise _error(401, "NODE_AUTH_MISSING", "authorization bearer token required")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise _error(401, "NODE_AUTH_INVALID", "authorization header must be Bearer <token>")
    return _verify_node_access_token(token)


def _apply_heartbeat_ttl() -> None:
    now = _now()
    for node in NODE_REGISTRY.values():
        age_ms = (now - node.lastHeartbeatAt).total_seconds() * 1000
        if age_ms > NODE_HEARTBEAT_TTL_MS and node.status != "offline":
            node.status = "offline"


def _scope_allows_node(claims: NodeAuthClaims, node_tenant_id: Optional[str]) -> bool:
    if claims.tenantScope == "*":
        return True
    if not node_tenant_id:
        return False
    return claims.tenantScope == node_tenant_id


def _prom_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _select_node(task_type: str, model_ref: str, tenant_id: str) -> Optional[InferenceNode]:
    _apply_heartbeat_ttl()
    candidates: List[InferenceNode] = []
    for node in NODE_REGISTRY.values():
        if node.nodeId in REVOKED_NODES:
            continue
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
    _apply_heartbeat_ttl()
    online = sum(1 for node in NODE_REGISTRY.values() if node.status == "online")
    degraded = sum(1 for node in NODE_REGISTRY.values() if node.status == "degraded")
    offline = sum(1 for node in NODE_REGISTRY.values() if node.status == "offline")
    return {
        "ok": True,
        "service": "inference-bridge",
        "nodes": len(NODE_REGISTRY),
        "nodeAuth": {
            "enabled": True,
            "online": online,
            "degraded": degraded,
            "offline": offline,
            "revoked": len(REVOKED_NODES),
            "heartbeatTtlMs": NODE_HEARTBEAT_TTL_MS,
        },
    }


@app.get("/metrics")
def metrics():
    _apply_heartbeat_ttl()
    now = _now()
    online = sum(1 for node in NODE_REGISTRY.values() if node.status == "online")
    degraded = sum(1 for node in NODE_REGISTRY.values() if node.status == "degraded")
    offline = sum(1 for node in NODE_REGISTRY.values() if node.status == "offline")
    drained = sum(1 for node in NODE_REGISTRY.values() if node.isDrained)

    enrollment_active = 0
    enrollment_used = 0
    enrollment_expired = 0
    for token in ENROLLMENT_TOKENS.values():
        if token.used:
            enrollment_used += 1
        elif token.expiresAt <= now:
            enrollment_expired += 1
        else:
            enrollment_active += 1

    refresh_active = 0
    refresh_revoked = 0
    refresh_expired = 0
    for token in REFRESH_TOKENS.values():
        if token.revoked:
            refresh_revoked += 1
        elif token.expiresAt <= now:
            refresh_expired += 1
        else:
            refresh_active += 1

    lines = [
        "# HELP nearhome_inference_bridge_up 1 if inference bridge process is up.",
        "# TYPE nearhome_inference_bridge_up gauge",
        "nearhome_inference_bridge_up 1",
        "# HELP nearhome_node_registry_total Total registered inference nodes.",
        "# TYPE nearhome_node_registry_total gauge",
        f"nearhome_node_registry_total {len(NODE_REGISTRY)}",
        "# HELP nearhome_node_registry_status Total nodes by status.",
        "# TYPE nearhome_node_registry_status gauge",
        f'nearhome_node_registry_status{{status="online"}} {online}',
        f'nearhome_node_registry_status{{status="degraded"}} {degraded}',
        f'nearhome_node_registry_status{{status="offline"}} {offline}',
        "# HELP nearhome_node_registry_drained_total Total drained nodes.",
        "# TYPE nearhome_node_registry_drained_total gauge",
        f"nearhome_node_registry_drained_total {drained}",
        "# HELP nearhome_node_revoked_total Total revoked nodes.",
        "# TYPE nearhome_node_revoked_total gauge",
        f"nearhome_node_revoked_total {len(REVOKED_NODES)}",
        "# HELP nearhome_node_heartbeat_ttl_ms Heartbeat TTL configured for nodes in milliseconds.",
        "# TYPE nearhome_node_heartbeat_ttl_ms gauge",
        f"nearhome_node_heartbeat_ttl_ms {NODE_HEARTBEAT_TTL_MS}",
        "# HELP nearhome_node_auth_enrollment_tokens_total Enrollment tokens by state.",
        "# TYPE nearhome_node_auth_enrollment_tokens_total gauge",
        f'nearhome_node_auth_enrollment_tokens_total{{state="active"}} {enrollment_active}',
        f'nearhome_node_auth_enrollment_tokens_total{{state="used"}} {enrollment_used}',
        f'nearhome_node_auth_enrollment_tokens_total{{state="expired"}} {enrollment_expired}',
        "# HELP nearhome_node_auth_refresh_tokens_total Refresh tokens by state.",
        "# TYPE nearhome_node_auth_refresh_tokens_total gauge",
        f'nearhome_node_auth_refresh_tokens_total{{state="active"}} {refresh_active}',
        f'nearhome_node_auth_refresh_tokens_total{{state="revoked"}} {refresh_revoked}',
        f'nearhome_node_auth_refresh_tokens_total{{state="expired"}} {refresh_expired}',
    ]

    lines.append("# HELP nearhome_node_last_heartbeat_age_seconds Last heartbeat age in seconds per node.")
    lines.append("# TYPE nearhome_node_last_heartbeat_age_seconds gauge")
    for node in NODE_REGISTRY.values():
        age_seconds = max(0, int((now - node.lastHeartbeatAt).total_seconds()))
        tenant_label = node.tenantId or ""
        lines.append(
            'nearhome_node_last_heartbeat_age_seconds{node_id="%s",tenant_id="%s",status="%s",drained="%s"} %s'
            % (
                _prom_escape(node.nodeId),
                _prom_escape(tenant_label),
                _prom_escape(node.status),
                "true" if node.isDrained else "false",
                age_seconds,
            )
        )

    return Response("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4; charset=utf-8")


@app.post("/internal/nodes/enrollment-tokens")
def create_enrollment_token(body: EnrollmentTokenCreateRequest, _admin: None = Depends(_require_admin_auth)):
    if body.nodeId in REVOKED_NODES:
        raise _error(403, "NODE_REVOKED", "node has been revoked", {"nodeId": body.nodeId})
    token = secrets.token_urlsafe(32)
    ttl_seconds = max(60, body.ttlSeconds or ENROLLMENT_TOKEN_TTL_SECONDS)
    entry = EnrollmentTokenEntry(
        nodeId=body.nodeId,
        tenantScope=body.tenantScope or "*",
        expiresAt=_now() + timedelta(seconds=ttl_seconds),
    )
    ENROLLMENT_TOKENS[token] = entry
    return {"data": {"nodeId": body.nodeId, "enrollmentToken": token, "tenantScope": entry.tenantScope, "expiresAt": entry.expiresAt}}


@app.post("/v1/nodes/enroll")
def enroll_node(body: NodeEnrollRequest):
    entry = ENROLLMENT_TOKENS.get(body.enrollmentToken)
    if not entry:
        raise _error(409, "NODE_ENROLLMENT_TOKEN_INVALID", "enrollment token invalid")
    if entry.used:
        raise _error(409, "NODE_ENROLLMENT_TOKEN_USED", "enrollment token already used")
    if entry.expiresAt <= _now():
        raise _error(409, "NODE_ENROLLMENT_TOKEN_INVALID", "enrollment token expired")
    if entry.nodeId != body.nodeId:
        raise _error(409, "NODE_ID_MISMATCH", "enrollment token nodeId mismatch", {"expectedNodeId": entry.nodeId, "receivedNodeId": body.nodeId})
    entry.used = True

    node_access_token, expires_at = _create_node_access_token(body.nodeId, entry.tenantScope)
    refresh_token = secrets.token_urlsafe(40)
    REFRESH_TOKENS[refresh_token] = RefreshTokenEntry(
        nodeId=body.nodeId,
        tenantScope=entry.tenantScope,
        expiresAt=_now() + timedelta(seconds=NODE_REFRESH_TTL_SECONDS),
    )
    return {
        "data": {
            "nodeId": body.nodeId,
            "authMode": "jwt",
            "nodeAccessToken": node_access_token,
            "expiresAt": expires_at,
            "refreshToken": refresh_token,
        }
    }


@app.post("/v1/nodes/token/refresh")
def refresh_node_token(body: NodeRefreshRequest):
    entry = REFRESH_TOKENS.get(body.refreshToken)
    if not entry or entry.revoked:
        raise _error(401, "NODE_AUTH_INVALID", "refresh token invalid")
    if entry.expiresAt <= _now():
        raise _error(401, "NODE_AUTH_EXPIRED", "refresh token expired")
    if entry.nodeId != body.nodeId:
        raise _error(409, "NODE_ID_MISMATCH", "refresh token nodeId mismatch")
    if body.nodeId in REVOKED_NODES:
        raise _error(403, "NODE_REVOKED", "node has been revoked", {"nodeId": body.nodeId})
    node_access_token, expires_at = _create_node_access_token(body.nodeId, entry.tenantScope)
    return {
        "data": {
            "nodeId": body.nodeId,
            "authMode": "jwt",
            "nodeAccessToken": node_access_token,
            "expiresAt": expires_at,
        }
    }


@app.post("/v1/nodes/register")
def register_node(node: InferenceNode, auth: NodeAuthClaims = Depends(_require_node_auth)):
    if auth.sub != node.nodeId:
        raise _error(409, "NODE_ID_MISMATCH", "token nodeId mismatch", {"tokenNodeId": auth.sub, "payloadNodeId": node.nodeId})
    if not _scope_allows_node(auth, node.tenantId):
        raise _error(403, "NODE_SCOPE_FORBIDDEN", "node token tenant scope does not allow this registration")
    node.lastHeartbeatAt = _now()
    NODE_REGISTRY[node.nodeId] = node
    return {"data": node}


@app.post("/v1/nodes/heartbeat")
def heartbeat(payload: HeartbeatRequest, auth: NodeAuthClaims = Depends(_require_node_auth)):
    if auth.sub != payload.nodeId:
        raise _error(409, "NODE_ID_MISMATCH", "token nodeId mismatch", {"tokenNodeId": auth.sub, "payloadNodeId": payload.nodeId})
    current = NODE_REGISTRY.get(payload.nodeId)
    if not current:
        raise _error(404, "NODE_NOT_FOUND", "node is not registered", {"nodeId": payload.nodeId})
    if not _scope_allows_node(auth, current.tenantId):
        raise _error(403, "NODE_SCOPE_FORBIDDEN", "node token tenant scope does not allow this heartbeat")

    current.status = payload.status
    if payload.queueDepth is not None:
        current.queueDepth = payload.queueDepth
    if payload.resources is not None:
        current.resources = payload.resources
    current.lastHeartbeatAt = _now()
    NODE_REGISTRY[payload.nodeId] = current
    return {"data": current}


@app.get("/v1/nodes")
def list_nodes():
    _apply_heartbeat_ttl()
    return {"data": [node.model_dump(mode="json") for node in NODE_REGISTRY.values()], "total": len(NODE_REGISTRY)}


@app.post("/v1/nodes/{node_id}/drain")
def drain_node(node_id: str, _admin: None = Depends(_require_admin_auth)):
    node = NODE_REGISTRY.get(node_id)
    if not node:
        raise _error(404, "NODE_NOT_FOUND", "node not found", {"nodeId": node_id})
    node.isDrained = True
    return {"data": node}


@app.post("/v1/nodes/{node_id}/undrain")
def undrain_node(node_id: str, _admin: None = Depends(_require_admin_auth)):
    node = NODE_REGISTRY.get(node_id)
    if not node:
        raise _error(404, "NODE_NOT_FOUND", "node not found", {"nodeId": node_id})
    node.isDrained = False
    return {"data": node}


@app.post("/v1/nodes/{node_id}/revoke")
def revoke_node(node_id: str, body: NodeRevokeRequest, _admin: None = Depends(_require_admin_auth)):
    REVOKED_NODES.add(node_id)
    node = NODE_REGISTRY.get(node_id)
    if node:
        node.status = "offline"
        node.isDrained = True
        node.lastHeartbeatAt = _now()
        NODE_REGISTRY[node_id] = node
    for refresh in REFRESH_TOKENS.values():
        if refresh.nodeId == node_id:
            refresh.revoked = True
    return {"data": {"nodeId": node_id, "revoked": True, "reason": body.reason}}


@app.post("/v1/infer")
async def infer(payload: InferRequest):
    if payload.provider != "onprem_bento":
        return InferResponse(
            detections=[
                {
                    "label": "person",
                    "confidence": 0.71,
                    "bbox": {"x": 0.22, "y": 0.16, "w": 0.2, "h": 0.4},
                    "attributes": {"provider": payload.provider},
                }
            ],
            providerLatencyMs=25,
            providerMeta={"provider": payload.provider, "mode": "mock"},
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
