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
- `STREAM_MEDIA_ENGINE` (`mock` por defecto)
- `STREAM_TRANSCODER_CMD` (cuando `STREAM_MEDIA_ENGINE=process`)
- `STREAM_TRANSCODER_SHELL`
- `STREAM_TRANSCODER_START_TIMEOUT_MS`
- `STREAM_TRANSCODER_STOP_TIMEOUT_MS`
- `STREAM_TRANSCODER_PRESET` (`custom|ffmpeg-hls`)
- `STREAM_TRANSCODER_DRY_RUN` (`1` para validar comando sin ejecutar proceso)
- `STREAM_TRANSCODER_RESTART_MAX`
- `STREAM_TRANSCODER_RESTART_BACKOFF_MS`
- `STREAM_TRANSCODER_RESTART_BACKOFF_MAX_MS`

## Notas

- En esta iteración genera un manifiesto/segmento mock para validar integración end-to-end.
- El token de playback es firmado (HMAC SHA-256) y valida `tenantId`, `cameraId`, firma y expiración.
- Worker interno de probes mock actualiza salud por stream (`online|degraded|offline`) cada `STREAM_PROBE_INTERVAL_MS`.
- `GET /health/:tenantId/:cameraId` devuelve `status` y `health` para sincronización en control-plane.
- Provisioning es idempotente por `tenantId+cameraId`; si la config no cambia, no reprovisiona.
- Session manager interno trackea `sid` del token (`issued|active|ended|expired`) con TTL y sweep.
- El motor de media está desacoplado por adapter (`MediaEngine`) para integrar data-plane real sin cambiar el contrato HTTP.

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
- `nearhome_media_workers_total{state}`
- `nearhome_media_worker_restarts_total`

## Data-plane adapter (NH-DP-05)

- `buildApp({ mediaEngine })` permite inyectar un motor custom.
- `GET /health` expone `mediaEngine` activo para diagnóstico operacional.

## Process Engine (NH-DP-06)

- Modo `STREAM_MEDIA_ENGINE=process` para ejecutar un worker de ingesta/transcode por cámara.
- El worker se lanza con `STREAM_TRANSCODER_CMD` (template soportado: `{{tenantId}}`, `{{cameraId}}`, `{{rtspUrl}}`).
- `GET /health` incluye `mediaEngineDiagnostics.workers` con `total|running|restarting|stopped|failed`.

## Process Supervisor (NH-DP-07)

- Restart automático con backoff exponencial para workers que salen con error.
- Preset `ffmpeg-hls` para comando de transcode sin romper contrato HTTP.
- Diagnóstico por worker en health: `state`, `restartCount`, `command`, `lastExitCode`, `lastExitSignal`.
