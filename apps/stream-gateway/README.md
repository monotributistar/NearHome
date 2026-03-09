# Stream Gateway (Data Plane MVP)

Servicio MVP para provisionar playback por cámara.

## Endpoints

- `POST /provision` `{ tenantId, cameraId, rtspUrl, transport?, encryption?, tunnel?, codecHint?, targetProfiles? }`
- `POST /deprovision` `{ tenantId, cameraId }`
- `GET /health`
- `GET /health/:tenantId/:cameraId` (incluye runtime: live-edge lag + estado de worker)
- `GET /metrics` (formato Prometheus)
- `GET /playback/:tenantId/:cameraId/index.m3u8?token=`
- `GET /playback/:tenantId/:cameraId/segment0.ts?token=`
- `GET /playback/:tenantId/:cameraId/segments/:segmentName?token=`
- `GET /sessions` (filtros `tenantId`, `cameraId`, `status`, `sid`)
- `POST /sessions/sweep` (forzar sweep de TTL para operación/testing)
- `POST /retention/sweep` (forzar sweep de retención de storage)
- `GET /storage/vaults` (estado + health de vaults)
- `POST /storage/vaults` (alta runtime de vault)
- `PATCH /storage/vaults/:vaultId` (editar vault)
- `DELETE /storage/vaults/:vaultId` (eliminar vault no-default y sin streams activos)
- `POST /storage/vaults/:vaultId/check` (healthcheck manual)
- `GET /storage/plan-vault-map`
- `PUT /storage/plan-vault-map`
- `POST /events/clip` (crear clip por evento con ventana pre/post)
- `GET /events/clips` (listar clips)
- `GET /events/clips/:tenantId/:cameraId/:eventId`
- `GET /playback/events/:tenantId/:cameraId/:eventId/index.m3u8?token=`
- `GET /playback/events/:tenantId/:cameraId/:eventId/clip.ts?token=`

## Variables de entorno

- `STREAM_STORAGE_DIR`
- `STREAM_TOKEN_SECRET`
- `STREAM_PROBE_INTERVAL_MS`
- `STREAM_DEFAULT_INGEST_TRANSPORT` (`auto|tcp|udp`, default `auto`)
- `STREAM_DEFAULT_INGEST_ENCRYPTION` (`optional|required|disabled`, default `optional`)
- `STREAM_DEFAULT_INGEST_TUNNEL` (`none|http|https|ws|wss|auto`, default `none`)
- `STREAM_SESSION_IDLE_TTL_MS`
- `STREAM_SESSION_SWEEP_MS`
- `STREAM_PLAYBACK_READ_RETRIES`
- `STREAM_PLAYBACK_READ_RETRY_BASE_MS`
- `STREAM_PLAYBACK_READ_RETRY_MAX_MS`
- `STREAM_PLAYBACK_READ_TIMEOUT_MS`
- `STREAM_PLAYBACK_SLOW_MS`
- `STREAM_PLAYBACK_LIVE_EDGE_STALE_MS` (default `3000`, umbral para marcar lag de live-edge como degradado)
- `STREAM_CORS_ORIGINS` (CSV de origins permitidos para browser; default `*`)
- `STREAM_MAX_ACTIVE_SESSIONS_PER_TENANT` (`0` deshabilita límite)
- `STREAM_MEDIA_ENGINE` (`mock|process|process-mediamtx`, `mock` por defecto)
- `STREAM_STORAGE_DEFAULT_VAULT_ID` (vault por defecto)
- `STREAM_STORAGE_VAULTS_JSON` (lista JSON de vaults filesystem)
- `STREAM_STORAGE_PLAN_VAULT_MAP_JSON` (map JSON `planCode -> vaultId`)
- `STREAM_STORAGE_FAILOVER_ENABLED` (`1` default; fallback a otro vault sano)
- `STREAM_STORAGE_HEALTHCHECK_ENABLED` (`1` default)
- `STREAM_STORAGE_HEALTHCHECK_MS` (default `30000`)
- `STREAM_STORAGE_HEALTHCHECK_WRITE_PROBE` (`1` default; write+unlink probe)
- `STREAM_STORAGE_TENANT_QUOTAS_JSON` (map JSON `tenantId -> bytes`, soporta `*`)
- `STREAM_STORAGE_DEFAULT_TENANT_QUOTA_BYTES` (default `0` = sin quota)
- `STREAM_STORAGE_TENANT_QUOTA_TARGET_PCT` (default `90`, target tras cleanup por quota)
- `recordingMode` en `/provision` (`continuous|event_only|hybrid|observe_only`)
- `eventClipPreSeconds` en `/provision` (default `5`)
- `eventClipPostSeconds` en `/provision` (default `10`)
- `STREAM_EVENT_CLIP_STRATEGY` (`concat|ffmpeg`, default `concat`)
- `STREAM_EVENT_CLIP_FFMPEG_BIN` (default `ffmpeg`, usado en strategy `ffmpeg`)
- `STREAM_OBSERVE_SCRATCH_DIR` (base efímera para `recordingMode=observe_only`)
- `STREAM_TRANSCODER_CMD` (cuando `STREAM_MEDIA_ENGINE=process`)
- `STREAM_TRANSCODER_SHELL`
- `STREAM_TRANSCODER_START_TIMEOUT_MS`
- `STREAM_TRANSCODER_STOP_TIMEOUT_MS`
- `STREAM_TRANSCODER_PRESET` (`custom|ffmpeg-hls|ffmpeg-hls-retention|mediamtx-rtsp-pull`)
- `STREAM_TRANSCODER_DRY_RUN` (`1` para validar comando sin ejecutar proceso)
- `STREAM_TRANSCODER_RESTART_MAX`
- `STREAM_TRANSCODER_RESTART_BACKOFF_MS`
- `STREAM_TRANSCODER_RESTART_BACKOFF_MAX_MS`
- `STREAM_MEDIAMTX_BIN` (default `mediamtx`)
- `STREAM_MEDIAMTX_ARGS` (args extra para binario MediaMTX)
- `STREAM_MEDIAMTX_READ_TIMEOUT` (default `10s`)
- `STREAM_MEDIAMTX_WRITE_TIMEOUT` (default `10s`)
- `STREAM_RETENTION_ENABLED` (`1` habilita loop de retención)
- `STREAM_RETENTION_DAYS` (default `7`)
- `STREAM_RETENTION_SWEEP_MS` (default `300000`)
- `STREAM_RETENTION_MIN_FILE_AGE_SECONDS` (default `45`)
- `STREAM_RETENTION_MAX_DISK_USAGE_PCT` (default `85`)
- `STREAM_RETENTION_TARGET_DISK_USAGE_PCT` (default `75`)
- `STREAM_RETENTION_FILE_EXTENSIONS` (default `.ts,.m4s,.mp4,.mkv,.fmp4`)
- `STREAM_RETENTION_SEGMENT_SECONDS` (default `1`, usado por `ffmpeg-hls-retention`)
- `STREAM_RETENTION_LIVE_LIST_SIZE` (default `3`, usado por `ffmpeg-hls-retention`)
- `STREAM_FFMPEG_VIDEO_MODE` (`copy|cbr`, default `copy`)
- `STREAM_FFMPEG_TARGET_BITRATE_KBPS` (default `2500`, usado en modo `cbr`)
- `STREAM_FFMPEG_MAXRATE_KBPS` (default `3000`, usado en modo `cbr`)
- `STREAM_FFMPEG_BUFSIZE_KBPS` (default `5000`, usado en modo `cbr`)
- `STREAM_FFMPEG_OUTPUT_FPS` (default `15`, usado en modo `cbr`)
- `STREAM_FFMPEG_KEYFRAME_SECONDS` (default `1`, usado en modo `cbr` para forzar GOP corto)

## Notas

- En esta iteración genera un manifiesto/segmento mock para validar integración end-to-end.
- El token de playback es firmado (HMAC SHA-256) y valida `tenantId`, `cameraId`, firma y expiración.
- Worker interno de probes mock actualiza salud por stream (`online|degraded|offline`) cada `STREAM_PROBE_INTERVAL_MS`.
- `GET /health/:tenantId/:cameraId` devuelve `status` y `health` para sincronización en control-plane.
- Provisioning es idempotente por `tenantId+cameraId`; si la config no cambia, no reprovisiona.
- `transport`, `encryption` y `tunnel` pueden venir por request o tomar defaults de env para perfiles LAN/Internet.
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
- `PLAYBACK_TENANT_CAPACITY_EXCEEDED`
- `PLAYBACK_ASSET_TIMEOUT`
- `PLAYBACK_STREAM_NOT_FOUND`
- `PLAYBACK_STREAM_NOT_READY`
- `PLAYBACK_STREAM_STOPPED`
- `PLAYBACK_MANIFEST_NOT_FOUND`
- `PLAYBACK_SEGMENT_NOT_FOUND`

## Observabilidad playback (NH-DP-04)

- `nearhome_playback_requests_total{tenant_id,camera_id,asset,result}`
- `nearhome_playback_errors_total{tenant_id,camera_id,asset,code}`
- `nearhome_playback_read_retries_total{tenant_id,camera_id,asset}`
- `nearhome_playback_slow_requests_total{tenant_id,camera_id,asset}`
- `nearhome_playback_latency_ms_sum{tenant_id,camera_id,asset}`
- `nearhome_playback_latency_ms_count{tenant_id,camera_id,asset}`
- `nearhome_playback_live_edge_lag_ms{tenant_id,camera_id}`
- `nearhome_playback_live_edge_observed_unixtime_seconds{tenant_id,camera_id}`
- `nearhome_playback_live_edge_stale_total{tenant_id,camera_id}`
- `nearhome_media_workers_total{state}`
- `nearhome_media_worker_restarts_total`
- `nearhome_storage_retention_enabled`
- `nearhome_storage_retention_sweeps_total`
- `nearhome_storage_retention_deleted_files_total`
- `nearhome_storage_retention_deleted_bytes_total`
- `nearhome_storage_retention_deleted_quota_files_total`
- `nearhome_storage_retention_deleted_quota_bytes_total`
- `nearhome_storage_tenant_quota_exceeded_total`
- `nearhome_storage_failover_provision_total`
- `nearhome_storage_usage_bytes{state=total|used|free}`
- `nearhome_storage_usage_pct`
- `nearhome_storage_vault_health{vault_id}`
- `nearhome_storage_vault_usage_pct{vault_id}`
- `nearhome_storage_event_clips_created_total`
- `nearhome_storage_event_clips_bytes_total`

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

## Process MediaMTX Alias (NH-DP-11)

- Modo `STREAM_MEDIA_ENGINE=process-mediamtx` para arrancar engine de proceso con preset por defecto `mediamtx-rtsp-pull`.
- El preset genera config YAML por cámara (`mediamtx.generated.yml`) y comando de arranque visible en diagnostics.
- Mantiene el contrato HTTP del gateway para provision/playback/health, habilitando migración progresiva del motor interno.

## Dynamic Segments + ffmpeg smoke (NH-DP-08A)

- El manifiesto de playback reescribe segmentos HLS a rutas tokenizadas del gateway (`/segments/:segmentName`).
- Compatible con nombres de segmento dinámicos emitidos por ffmpeg.
- Test de smoke con ffmpeg real (si está instalado) usando input sintético `lavfi`.

## Weekly Retention Mode

- `POST /retention/sweep` ejecuta limpieza manual por antigüedad y presión de disco.
- El modo `ffmpeg-hls-retention` mantiene playback en vivo (`index.m3u8`) y persistencia de segmentos en disco.
- El preset aplica flags de baja latencia en ffmpeg (`nobuffer`, `low_delay`, `delete_segments`, `split_by_time`) para priorizar el cuadro más reciente.
- Para acercarse al "latest frame", usar `STREAM_FFMPEG_VIDEO_MODE=cbr` con `STREAM_FFMPEG_KEYFRAME_SECONDS=1`; en modo `copy` la latencia mínima queda atada al GOP/keyframe del encoder de cámara.
- La retención elimina:
  - primero archivos fuera de ventana (`STREAM_RETENTION_DAYS`),
  - luego archivos más antiguos por watermark si disco supera `STREAM_RETENTION_MAX_DISK_USAGE_PCT`.
- Si `POST /provision` recibe `planCode` y/o `storageVaultId`, el stream se enruta al vault correspondiente.
- Si `POST /provision` recibe `retentionDays`, se aplica esa ventana por cámara (alineado a entitlements).
- Si un vault objetivo está unhealthy, provisioning puede hacer failover al siguiente vault healthy.
- Si el tenant supera su quota, `POST /provision` responde `STORAGE_TENANT_QUOTA_EXCEEDED`.
