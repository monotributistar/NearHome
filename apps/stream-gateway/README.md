# Stream Gateway (Data Plane MVP)

Servicio MVP para provisionar playback por cámara.

## Endpoints

- `POST /provision` `{ tenantId, cameraId, rtspUrl, transport?, codecHint?, targetProfiles? }`
- `POST /deprovision` `{ tenantId, cameraId }`
- `GET /health`
- `GET /health/:tenantId/:cameraId`
- `GET /metrics` (formato Prometheus)
- `GET /playback/:tenantId/:cameraId/index.m3u8?token=`
- `GET /playback/:tenantId/:cameraId/segment0.ts?token=`
- `GET /sessions` (filtros `tenantId`, `cameraId`, `status`, `sid`)
- `POST /sessions/sweep` (forzar sweep de TTL para operación/testing)

## Variables de entorno

- `STREAM_STORAGE_DIR`
- `STREAM_TOKEN_SECRET`
- `STREAM_PROBE_INTERVAL_MS`
- `STREAM_SESSION_IDLE_TTL_MS`
- `STREAM_SESSION_SWEEP_MS`
- `STREAM_PLAYBACK_READ_RETRIES`
- `STREAM_PLAYBACK_READ_RETRY_BASE_MS`
- `STREAM_PLAYBACK_READ_RETRY_MAX_MS`

## Notas

- En esta iteración genera un manifiesto/segmento mock para validar integración end-to-end.
- El token de playback es firmado (HMAC SHA-256) y valida `tenantId`, `cameraId`, firma y expiración.
- Worker interno de probes mock actualiza salud por stream (`online|degraded|offline`) cada `STREAM_PROBE_INTERVAL_MS`.
- `GET /health/:tenantId/:cameraId` devuelve `status` y `health` para sincronización en control-plane.
- Provisioning es idempotente por `tenantId+cameraId`; si la config no cambia, no reprovisiona.
- Session manager interno trackea `sid` del token (`issued|active|ended|expired`) con TTL y sweep.

## Errores playback (NH-DP-03)

- `PLAYBACK_TOKEN_MISSING`
- `PLAYBACK_TOKEN_FORMAT_INVALID`
- `PLAYBACK_TOKEN_SIGNATURE_INVALID`
- `PLAYBACK_TOKEN_PAYLOAD_INVALID`
- `PLAYBACK_TOKEN_EXPIRED`
- `PLAYBACK_TOKEN_SCOPE_MISMATCH`
- `PLAYBACK_SESSION_CLOSED`
- `PLAYBACK_STREAM_NOT_FOUND`
- `PLAYBACK_STREAM_NOT_READY`
- `PLAYBACK_STREAM_STOPPED`
- `PLAYBACK_MANIFEST_NOT_FOUND`
- `PLAYBACK_SEGMENT_NOT_FOUND`

## Observabilidad playback (NH-DP-04)

- `nearhome_playback_requests_total{tenant_id,camera_id,asset,result}`
- `nearhome_playback_errors_total{tenant_id,camera_id,asset,code}`
- `nearhome_playback_read_retries_total{tenant_id,camera_id,asset}`
