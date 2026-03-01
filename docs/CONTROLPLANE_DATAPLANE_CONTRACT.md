# Contrato Control Plane <-> Data Plane (NH-017)

## Objetivo

Definir contrato mínimo y versionable entre:

- Control Plane (`apps/api`)
- Data Plane (`apps/stream-gateway`)

## Base URL (dev)

- Data Plane: `http://localhost:3010`

## Endpoints consumidos por Control Plane

### 1) Provision stream

- `POST /provision`
- in:

```json
{
  "tenantId": "string",
  "cameraId": "string",
  "rtspUrl": "string",
  "transport": "auto|tcp|udp",
  "codecHint": "h264|h265|mpeg4|unknown",
  "targetProfiles": ["main", "sub"]
}
```

- out:

```json
{
  "data": {
    "tenantId": "string",
    "cameraId": "string",
    "rtspUrl": "string",
    "source": {
      "transport": "auto|tcp|udp",
      "codecHint": "h264|h265|mpeg4|unknown",
      "targetProfiles": ["main"]
    },
    "version": 1,
    "reprovisioned": true,
    "status": "provisioning|ready|stopped",
    "health": {
      "connectivity": "online|degraded|offline",
      "latencyMs": 100,
      "packetLossPct": 0.2,
      "jitterMs": 5,
      "error": null,
      "checkedAt": "ISO-8601"
    },
    "updatedAt": "ISO-8601",
    "playbackPath": "/playback/:tenantId/:cameraId/index.m3u8"
  }
}
```

### 2) Deprovision stream

- `POST /deprovision`
- in:

```json
{
  "tenantId": "string",
  "cameraId": "string"
}
```

- out:

```json
{
  "data": {
    "removed": true
  }
}
```

### 3) Health por cámara

- `GET /health/:tenantId/:cameraId`
- `200`:

```json
{
  "ok": true,
  "data": {
    "tenantId": "string",
    "cameraId": "string",
    "rtspUrl": "string",
    "status": "provisioning|ready|stopped",
    "health": {
      "connectivity": "online|degraded|offline",
      "latencyMs": 120,
      "packetLossPct": 0.1,
      "jitterMs": 7,
      "error": null,
      "checkedAt": "ISO-8601"
    },
    "updatedAt": "ISO-8601"
  }
}
```

- `404`:

```json
{
  "ok": false,
  "reason": "not_provisioned"
}
```

### 4) Playback

- `GET /playback/:tenantId/:cameraId/index.m3u8?token=...`
- `GET /playback/:tenantId/:cameraId/segment0.ts?token=...`

Token esperado:

- formato `base64url(payload).base64url(signature)`
- firma: `HMAC SHA-256` con `STREAM_TOKEN_SECRET`
- claims obligatorios:
  - `sub` (user id)
  - `tid` (tenant id)
  - `cid` (camera id)
  - `sid` (stream session id)
  - `exp` (epoch seconds)
  - `iat` (epoch seconds)
  - `v` (`1`)

Validación:

- firma válida
- no expirado
- `tid` y `cid` coinciden con path
- sesión (`sid`) activa para `tenantId+cameraId`

Errores tipificados playback (NH-DP-03):

- `401 PLAYBACK_TOKEN_MISSING`
- `401 PLAYBACK_TOKEN_FORMAT_INVALID`
- `401 PLAYBACK_TOKEN_SIGNATURE_INVALID`
- `401 PLAYBACK_TOKEN_PAYLOAD_INVALID`
- `401 PLAYBACK_TOKEN_EXPIRED`
- `403 PLAYBACK_TOKEN_SCOPE_MISMATCH`
- `401 PLAYBACK_SESSION_CLOSED`
- `404 PLAYBACK_STREAM_NOT_FOUND`
- `409 PLAYBACK_STREAM_NOT_READY`
- `410 PLAYBACK_STREAM_STOPPED`
- `404 PLAYBACK_MANIFEST_NOT_FOUND`
- `404 PLAYBACK_SEGMENT_NOT_FOUND`

Comportamiento de resiliencia (NH-DP-04):

- lectura de `index.m3u8` y `segment0.ts` con retry/backoff exponencial para errores transitorios (`ENOENT`, `EAGAIN`, `EBUSY`)
- configuración por env:
  - `STREAM_PLAYBACK_READ_RETRIES`
  - `STREAM_PLAYBACK_READ_RETRY_BASE_MS`
  - `STREAM_PLAYBACK_READ_RETRY_MAX_MS`

### 5) Session tracking (Data Plane)

- `GET /sessions`
  - filtros opcionales: `tenantId`, `cameraId`, `status`, `sid`
  - out: `{ data: StreamSession[], total }`
- `POST /sessions/sweep`
  - ejecuta sweep inmediato de TTL/idle
  - out: `{ data: { expired: number, ended: number } }`

## Sincronización Data Plane -> Control Plane

Control Plane expone:

- `POST /cameras/:id/sync-health` (tenant_admin)

Comportamiento:

- lee health de Data Plane en `/health/:tenantId/:cameraId`
- persiste `CameraHealthSnapshot`
- deriva `lifecycleStatus` en cámara
- registra auditoría `camera.health_sync`

## Observabilidad

Data Plane expone:

- `GET /metrics` (formato Prometheus)

Métricas actuales:

- `nearhome_streams_total{status=...}`
- `nearhome_stream_connectivity_total{connectivity=...}`
- `nearhome_stream_sessions_total{status=...}`
- `nearhome_stream_session_sweeps_total`
- `nearhome_playback_requests_total{tenant_id,camera_id,asset,result}`
- `nearhome_playback_errors_total{tenant_id,camera_id,asset,code}`
- `nearhome_playback_read_retries_total{tenant_id,camera_id,asset}`

## Variables de entorno relevantes

Control Plane:

- `STREAM_GATEWAY_URL`
- `STREAM_TOKEN_SECRET`

Data Plane:

- `STREAM_TOKEN_SECRET`
- `STREAM_PROBE_INTERVAL_MS`
- `STREAM_SESSION_IDLE_TTL_MS`
- `STREAM_SESSION_SWEEP_MS`
- `STREAM_PLAYBACK_READ_RETRIES`
- `STREAM_PLAYBACK_READ_RETRY_BASE_MS`
- `STREAM_PLAYBACK_READ_RETRY_MAX_MS`

## Versionado sugerido

- Mantener `v` en claims del token para cambios backward-compatible.
- Si cambia shape del payload health, agregar `contractVersion` en la respuesta `GET /health/:tenantId/:cameraId`.
