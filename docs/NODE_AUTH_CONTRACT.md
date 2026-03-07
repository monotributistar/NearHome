# NodeAuth v1 (Detection Plane)

Fecha de actualización: `2026-03-06`
Estado: `proposed` (contrato objetivo para implementación)

## 1) Objetivo

Definir autenticación, autorización y canal seguro para nodos de detección (`inference-node-*`) contra `inference-bridge`, sin exponer tráfico sensible fuera de red privada.

## 2) Alcance

- Enrolamiento inicial de nodo.
- Credencial de trabajo rotativa de corta vida.
- Heartbeat autenticado + expiración de presencia.
- Revocación de nodo.
- Reglas mínimas de red (LAN/VPN y puertos).

## 3) Modelo de seguridad

- Red:
  - Tráfico inter-nodo solo en red privada (overlay Docker local o VPN site-to-site/mesh en multi-host).
  - Sin exposición pública directa de `inference-node-*` ni `inference-bridge`.
- Identidad:
  - Cada nodo tiene `nodeId` único + `tenantScope` opcional.
- Transporte:
  - Objetivo: `mTLS` entre `bridge` y nodos.
  - Fase inicial permitida: TLS interno + JWT firmado de nodo.

## 4) Flujo NodeAuth v1

1. Bootstrap:
- Operador crea `enrollmentToken` de un solo uso para `nodeId`.
- Token tiene TTL corto (ej: 10 minutos).

2. Enrolamiento:
- Nodo llama `POST /v1/nodes/enroll` con `enrollmentToken`.
- Respuesta entrega credencial de trabajo:
  - opción A (objetivo): certificado cliente mTLS + expiración.
  - opción B (fase inicial): `nodeAccessToken` JWT corto (ej: 15 minutos) + `refreshToken`.

3. Registro:
- Nodo autenticado llama `POST /v1/nodes/register`.
- Bridge guarda metadata/capabilities y estado `online`.

4. Heartbeat:
- Nodo llama `POST /v1/nodes/heartbeat` periódicamente.
- Si `lastHeartbeatAt` supera `NODE_HEARTBEAT_TTL_MS`, bridge marca `offline`.

5. Revocación:
- Control-plane/ops llama `POST /v1/nodes/:id/revoke`.
- Credenciales del nodo quedan inválidas de inmediato.

## 5) Contrato HTTP propuesto

### 5.1 `POST /v1/nodes/enroll`

Request:

```json
{
  "nodeId": "node-yolo-01",
  "enrollmentToken": "opaque-one-time-token",
  "nonce": "random-string",
  "csr": "optional-pem-csr"
}
```

Response (JWT mode):

```json
{
  "data": {
    "nodeId": "node-yolo-01",
    "authMode": "jwt",
    "nodeAccessToken": "jwt",
    "expiresAt": "ISO-8601",
    "refreshToken": "opaque-refresh-token"
  }
}
```

Response (mTLS mode):

```json
{
  "data": {
    "nodeId": "node-yolo-01",
    "authMode": "mtls",
    "clientCertPem": "-----BEGIN CERTIFICATE-----...",
    "clientKeyPem": "-----BEGIN PRIVATE KEY-----...",
    "caCertPem": "-----BEGIN CERTIFICATE-----...",
    "expiresAt": "ISO-8601"
  }
}
```

### 5.2 `POST /v1/nodes/register` (auth required)

Request:

```json
{
  "nodeId": "node-yolo-01",
  "tenantId": "tenant-a",
  "runtime": "python",
  "transport": "http",
  "endpoint": "https://node-yolo-01.internal:8091",
  "status": "online",
  "resources": { "cpu": 4, "gpu": 1, "vramMb": 8192 },
  "capabilities": [
    { "capabilityId": "cap-yolo", "taskTypes": ["object_detection"], "models": ["yolo26n@1.0.0"] }
  ],
  "models": ["yolo26n@1.0.0"],
  "maxConcurrent": 4,
  "queueDepth": 0,
  "isDrained": false
}
```

Response:

```json
{
  "data": {
    "nodeId": "node-yolo-01",
    "status": "online"
  }
}
```

### 5.3 `POST /v1/nodes/heartbeat` (auth required)

Request:

```json
{
  "nodeId": "node-yolo-01",
  "status": "online",
  "queueDepth": 1,
  "resources": { "cpu": 4, "gpu": 1, "vramMb": 8192 }
}
```

Response:

```json
{
  "data": {
    "nodeId": "node-yolo-01",
    "status": "online",
    "lastHeartbeatAt": "ISO-8601"
  }
}
```

### 5.4 `POST /v1/nodes/:id/revoke`

Request:

```json
{
  "reason": "key_compromised"
}
```

Response:

```json
{
  "data": {
    "nodeId": "node-yolo-01",
    "revoked": true
  }
}
```

## 6) JWT claims (si authMode=jwt)

- `sub`: `nodeId`
- `typ`: `node`
- `iss`: `nearhome-control-plane`
- `aud`: `inference-bridge`
- `tenantScope`: `*` o `tenantId`
- `caps`: lista opcional de `taskTypes`
- `exp`, `iat`, `jti`

## 7) Errores estándar

- `401 NODE_AUTH_MISSING`
- `401 NODE_AUTH_INVALID`
- `401 NODE_AUTH_EXPIRED`
- `403 NODE_SCOPE_FORBIDDEN`
- `403 NODE_REVOKED`
- `409 NODE_ENROLLMENT_TOKEN_INVALID`
- `409 NODE_ENROLLMENT_TOKEN_USED`
- `409 NODE_ID_MISMATCH`
- `422 NODE_PAYLOAD_INVALID`

Shape:

```json
{
  "code": "NODE_AUTH_INVALID",
  "message": "node token signature invalid",
  "details": {}
}
```

## 8) Reglas de red mínimas

- Multi-host: VPN obligatoria (WireGuard/Tailscale) o red privada equivalente.
- `inference-bridge` y nodos sin puertos públicos en internet.
- ACL por host:
  - `bridge` acepta solo tráfico desde subred VPN/privada.
  - nodos aceptan solo tráfico desde `bridge`.
- Todo endpoint interno con TLS habilitado en ambientes fuera de laboratorio local.

## 9) Observabilidad requerida para NodeAuth

- Métricas mínimas (objetivo):
  - `nearhome_node_auth_success_total{mode}`
  - `nearhome_node_auth_fail_total{code}`
  - `nearhome_node_heartbeat_total{status}`
  - `nearhome_node_online_total`
  - `nearhome_node_revocations_total`
- Log estructurado:
  - `nodeId`, `tenantId`, `sourceIp`, `authMode`, `result`, `code`, `requestId`.

## 10) Plan de implementación incremental

1. Fase 1:
- JWT de nodo + enrollment token one-time + revocación.
- Heartbeat TTL y `offline` automático.

2. Fase 2:
- mTLS por nodo con CA interna y rotación automática.
- Endurecimiento de ACL por VPN/subred.

3. Fase 3:
- métricas/alertas SLO de disponibilidad de nodos y fallos de auth.
