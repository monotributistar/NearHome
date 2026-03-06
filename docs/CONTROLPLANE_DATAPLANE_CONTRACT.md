# Contrato Control Plane <-> Data Plane (NH-017)

Fecha de actualización: `2026-03-06`

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
  "encryption": "optional|required|disabled",
  "tunnel": "none|http|https|ws|wss|auto",
  "codecHint": "h264|h265|mpeg4|unknown",
  "targetProfiles": ["main", "sub"],
  "storageVaultId": "optional-string",
  "planCode": "optional-string",
  "retentionDays": 7,
  "recordingMode": "continuous|event_only|hybrid|observe_only",
  "eventClipPreSeconds": 5,
  "eventClipPostSeconds": 10
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
      "encryption": "optional|required|disabled",
      "tunnel": "none|http|https|ws|wss|auto",
      "codecHint": "h264|h265|mpeg4|unknown",
      "targetProfiles": ["main"]
    },
    "storage": {
      "vaultId": "vault-main",
      "vaultBasePath": "/data/storage",
      "cameraStorageDir": "/data/storage/tenant/camera",
      "observeScratchDir": null,
      "planCode": "pro",
      "retentionDays": 7,
      "recordingMode": "continuous",
      "eventClipPreSeconds": 5,
      "eventClipPostSeconds": 10
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

Notas de implementación (NH-DP-05):

- `stream-gateway` desacopla el motor de media mediante adapter (`MediaEngine`).
- El contrato HTTP de provision/playback se mantiene estable aunque cambie el motor subyacente.

Extensión NH-DP-06:

- engine `process` para ejecutar un worker real por stream (ingesta/transcode) manteniendo el mismo contrato HTTP.
- configuración de comando por env con template (`{{tenantId}}`, `{{cameraId}}`, `{{rtspUrl}}`).

Extensión NH-DP-07:

- supervisor de workers con restart/backoff para fallas transitorias del proceso.
- preset `ffmpeg-hls` para estandarizar comando de ingesta/transcode sobre RTSP.

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
- `GET /playback/:tenantId/:cameraId/segments/:segmentName?token=...`

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
- `409 PLAYBACK_TENANT_CAPACITY_EXCEEDED`
- `504 PLAYBACK_ASSET_TIMEOUT`
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
  - `STREAM_PLAYBACK_READ_TIMEOUT_MS`

Extensión NH-DP-08A:

- `index.m3u8` se reescribe para servir segmentos por ruta tokenizada dinámica (`/segments/:segmentName`).
- se mantiene compatibilidad con `segment0.ts` para flujos legacy/mock.

### 5) Session tracking (Data Plane)

- `GET /sessions`
  - filtros opcionales: `tenantId`, `cameraId`, `status`, `sid`
  - out: `{ data: StreamSession[], total }`
- `POST /sessions/sweep`
  - ejecuta sweep inmediato de TTL/idle
  - out: `{ data: { expired: number, ended: number } }`

### 6) Event clips (Control Plane proxy)

- `POST /events/clip`
  - in: `{ tenantId, cameraId, eventId?, source?, eventTs?, preSeconds?, postSeconds? }`
  - out: `{ data: { eventId, tenantId, cameraId, clipPath, clipBytes, playbackPath, ... } }`
  - error específico: `409 EVENT_CLIP_DISABLED_IN_OBSERVE_ONLY` cuando el stream está en `recordingMode=observe_only`.
- `GET /events/clips?tenantId=&cameraId=`
  - out: `{ data: EventClip[], total }`
- `GET /events/clips/:tenantId/:cameraId/:eventId`
  - out: `{ data: EventClip }`
- Playback de clips:
  - `GET /playback/events/:tenantId/:cameraId/:eventId/index.m3u8?token=...`
  - `GET /playback/events/:tenantId/:cameraId/:eventId/clip.ts?token=...`

### 7) Storage/vault operations (Data Plane)

- `GET /storage/vaults`
- `POST /storage/vaults/:vaultId/check`
- `POST /storage/vaults`
- `PATCH /storage/vaults/:vaultId`
- `DELETE /storage/vaults/:vaultId`
- `GET /storage/plan-vault-map`
- `PUT /storage/plan-vault-map`
- `POST /retention/sweep`

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

- `GET /health` (incluye `mediaEngine`)
- `GET /metrics` (formato Prometheus)

Cobertura actual por servicio:

- `stream-gateway`: `/health` + `/metrics` (Prometheus completo).
- `api`: `/health` + `/readiness` (sin `/metrics` Prometheus en esta etapa).
- `event-gateway`: `/health` (sin `/metrics` Prometheus en esta etapa).
- `inference-bridge` + `inference-node-*` + `detection-dispatcher`: `/health` (sin `/metrics` Prometheus en esta etapa).

Métricas actuales:

- `nearhome_streams_total{status=...}`
- `nearhome_stream_connectivity_total{connectivity=...}`
- `nearhome_stream_sessions_total{status=...}`
- `nearhome_stream_session_sweeps_total`
- `nearhome_playback_requests_total{tenant_id,camera_id,asset,result}`
- `nearhome_playback_errors_total{tenant_id,camera_id,asset,code}`
- `nearhome_playback_read_retries_total{tenant_id,camera_id,asset}`
- `nearhome_playback_slow_requests_total{tenant_id,camera_id,asset}`
- `nearhome_playback_latency_ms_sum{tenant_id,camera_id,asset}`
- `nearhome_playback_latency_ms_count{tenant_id,camera_id,asset}`
- `nearhome_media_workers_total{state}`
- `nearhome_media_worker_restarts_total`
- `nearhome_storage_retention_enabled`
- `nearhome_storage_retention_sweeps_total`
- `nearhome_storage_retention_deleted_files_total`
- `nearhome_storage_retention_deleted_bytes_total`
- `nearhome_storage_tenant_quota_exceeded_total`
- `nearhome_storage_failover_provision_total`
- `nearhome_storage_event_clips_created_total`
- `nearhome_storage_event_clips_bytes_total`
- `nearhome_storage_vault_health{vault_id}`
- `nearhome_storage_vault_usage_pct{vault_id}`

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
- `STREAM_PLAYBACK_READ_TIMEOUT_MS`
- `STREAM_PLAYBACK_SLOW_MS`
- `STREAM_MAX_ACTIVE_SESSIONS_PER_TENANT`
- `STREAM_MEDIA_ENGINE`
- `STREAM_TRANSCODER_CMD`
- `STREAM_TRANSCODER_SHELL`
- `STREAM_TRANSCODER_START_TIMEOUT_MS`
- `STREAM_TRANSCODER_STOP_TIMEOUT_MS`
- `STREAM_TRANSCODER_PRESET`
- `STREAM_TRANSCODER_DRY_RUN`
- `STREAM_TRANSCODER_RESTART_MAX`
- `STREAM_TRANSCODER_RESTART_BACKOFF_MS`
- `STREAM_TRANSCODER_RESTART_BACKOFF_MAX_MS`
- `STREAM_STORAGE_DEFAULT_VAULT_ID`
- `STREAM_STORAGE_VAULTS_JSON`
- `STREAM_STORAGE_PLAN_VAULT_MAP_JSON`
- `STREAM_STORAGE_FAILOVER_ENABLED`
- `STREAM_STORAGE_HEALTHCHECK_ENABLED`
- `STREAM_STORAGE_HEALTHCHECK_MS`
- `STREAM_STORAGE_HEALTHCHECK_WRITE_PROBE`
- `STREAM_STORAGE_TENANT_QUOTAS_JSON`
- `STREAM_STORAGE_DEFAULT_TENANT_QUOTA_BYTES`
- `STREAM_STORAGE_TENANT_QUOTA_TARGET_PCT`
- `STREAM_EVENT_CLIP_STRATEGY`
- `STREAM_EVENT_CLIP_FFMPEG_BIN`
- `STREAM_OBSERVE_SCRATCH_DIR`
- `STREAM_RETENTION_ENABLED`
- `STREAM_RETENTION_DAYS`
- `STREAM_RETENTION_SWEEP_MS`
- `STREAM_RETENTION_MIN_FILE_AGE_SECONDS`
- `STREAM_RETENTION_MAX_DISK_USAGE_PCT`
- `STREAM_RETENTION_TARGET_DISK_USAGE_PCT`
- `STREAM_RETENTION_FILE_EXTENSIONS`

## Versionado sugerido

- Mantener `v` en claims del token para cambios backward-compatible.
- Si cambia shape del payload health, agregar `contractVersion` en la respuesta `GET /health/:tenantId/:cameraId`.
