# API Changelog

## 2026-03-11 - v1.2.1

### Added

- NH-019: soporte operativo para staging con PostgreSQL sin romper desarrollo local en SQLite:
  - script de render Prisma para provider Postgres (`prisma:render:postgres`).
  - comandos `prisma:generate:postgres` y `db:push:postgres` en `@app/api`.
  - override de infraestructura `infra/docker-compose.postgres-staging.yml` para levantar API + Postgres en staging.
  - guía de ejecución en `docs/POSTGRES_STAGING.md`.
- NH-035: superadmin global con switch de contexto impersonado tenant-scoped:
  - header opcional `X-Impersonate-Role` (`tenant_admin|monitor|client_user`) para `super_admin`.
  - `/auth/me` expone `context` con actor real/efectivo e indicadores de impersonación.
  - enforcement de permisos por rol impersonado en rutas tenant-scoped.
  - auditoría en `AuditLog.payload._auth` con actor real + contexto efectivo.
- NH-036/NH-037: endurecimiento de identidad multi-tenant:
  - cobertura explícita de memberships N:M para `operator/customer` y enforcement `403` fuera de membresía.
  - cobertura explícita de gestión de roles: `super_admin` cambia rol por tenant y `tenant_admin` queda limitado a su tenant.

## 2026-02-24 - v1.2.0

### Added

- NH-011: soporte de correlación por request:
  - Header opcional de entrada `X-Request-Id`.
  - Header de salida `x-request-id` en todas las respuestas.
  - Logging estructurado `request.summary`.
- NH-013: compatibilidad de rutas con prefijo `/v1/*` sin romper rutas actuales.
- NH-012: endpoint de readiness con check de DB:
  - `GET /readiness` devuelve `200` (`db=up`) o `503` (`db=down`).
- NH-016: auditoría básica de acciones críticas:
  - `GET /audit-logs` (tenant-scoped, solo `tenant_admin`).
  - registro de acciones en cámaras y suscripciones.
- NH-029: administración completa de tenants:
  - `DELETE /tenants/:id` con soft delete.
  - tenants eliminados se excluyen de `/auth/me` y `/tenants`.
- NH-031: integración inicial con data-plane (`stream-gateway`):
  - `POST /cameras/:id/stream-token` puede devolver `playbackUrl`.
  - provision/deprovision best-effort hacia `STREAM_GATEWAY_URL`.
- NH-030: validación multi-tenant de monitor:
  - cobertura API y E2E de visibilidad de cámaras por tenant seleccionado.
- NH-018: stream token firmado para playback:
  - `POST /cameras/:id/stream-token` emite token HMAC SHA-256 con claims.
  - `stream-gateway` valida firma, expiración, `tenantId` y `cameraId`.
- NH-032: métricas básicas de data-plane:
  - `GET /metrics` en `stream-gateway` (formato Prometheus).
- NH-033: sincronización de salud de cámara desde data-plane:
  - `POST /cameras/:id/sync-health` (tenant_admin).
  - aplica update de `CameraHealthSnapshot` + lifecycle basado en health remoto.
- NH-034: scheduler automático de sync-health:
  - loop configurable por env en control-plane para cámaras activas.
  - tolerancia a fallos por cámara (no interrumpe sync global).
- NH-035: enforcement de entitlements en runtime:
  - `POST /cameras` aplica `limits.maxCameras`.
  - `POST /cameras/:id/stream-token` aplica `limits.maxConcurrentStreams`.
  - `GET /events` aplica `limits.retentionDays`.
  - nuevos códigos de error: `ENTITLEMENT_LIMIT_EXCEEDED`, `ENTITLEMENT_RETENTION_EXCEEDED`.
- NH-DP-01/NH-DP-02: evolución de data-plane para streams:
  - `POST /provision` soporta `transport`, `codecHint`, `targetProfiles`.
  - provisioning idempotente por `tenantId+cameraId` (`version`, `reprovisioned`).
  - session manager por `sid` con estado `issued|active|ended|expired`.
  - nuevos endpoints `GET /sessions` y `POST /sessions/sweep`.
  - métricas agregadas: `nearhome_stream_sessions_total`, `nearhome_stream_session_sweeps_total`.
- NH-DP-03: playback robusto con contrato de errores:
  - validación detallada de token (missing/format/signature/payload/expired).
  - validación de scope `tenantId/cameraId` con error explícito.
  - errores diferenciados por estado de stream (`not_found`, `not_ready`, `stopped`).
  - errores explícitos por sesión cerrada y assets faltantes (`manifest/segment`).
- NH-DP-04: resiliencia y observabilidad de playback:
  - retry/backoff configurable para lectura de assets (`index.m3u8`, `segment0.ts`) ante fallos transitorios.
  - métricas de playback por `tenant/camera/asset/result`.
  - métricas de errores de playback por `code` y de reintentos de lectura.
- NH-DP-05: adapter de media para data-plane:
  - `MediaEngine` desacoplado de rutas HTTP de `stream-gateway`.
  - inyección por `buildApp({ mediaEngine })` para pruebas/implementaciones reales.
  - `GET /health` informa `mediaEngine` activo.
- NH-DP-06: engine de proceso para ingesta/transcode:
  - soporte de `STREAM_MEDIA_ENGINE=process`.
  - worker por stream lanzado por comando configurable (`STREAM_TRANSCODER_CMD`).
  - `/health` incluye diagnóstico de workers (`total/running/stopped/failed`).
- NH-DP-07: supervisor del process engine:
  - restart automático de workers con backoff exponencial y límite configurable.
  - preset `ffmpeg-hls` para comando de transcode.
  - métricas nuevas: `nearhome_media_workers_total`, `nearhome_media_worker_restarts_total`.
- NH-DP-08A: compatibilidad de playback HLS con segmentos dinámicos:
  - endpoint `GET /playback/:tenantId/:cameraId/segments/:segmentName?token=...`.
  - reescritura de `index.m3u8` para assets tokenizados por segmento.
  - smoke test de playback real con ffmpeg (`lavfi`) sin cambiar contrato HTTP.
- NH-DP-08B: guardrail de concurrencia en data-plane por tenant:
  - límite opcional `STREAM_MAX_ACTIVE_SESSIONS_PER_TENANT`.
  - nuevo error `409 PLAYBACK_TENANT_CAPACITY_EXCEEDED` con detalle de capacidad.
  - aislamiento multi-tenant validado: el límite de tenant A no impacta tenant B.
- NH-DP-08C: timeout operativo de lectura de assets playback:
  - `STREAM_PLAYBACK_READ_TIMEOUT_MS` para budget máximo de lectura de `manifest/segment`.
  - nuevo error `504 PLAYBACK_ASSET_TIMEOUT` sin degradarlo a `404`.
  - cobertura de tests para timeout de manifest y segment.
- NH-DP-08D: observabilidad QoS de playback:
  - nuevas métricas: `nearhome_playback_latency_ms_sum`, `nearhome_playback_latency_ms_count`, `nearhome_playback_slow_requests_total`.
  - umbral de request lenta configurable con `STREAM_PLAYBACK_SLOW_MS`.
  - cobertura de tests para latencia y requests lentos por tenant/cámara/asset.
- NH-DP-09: prueba de carga multi-tenant de playback:
  - nueva suite `stream-gateway.load.spec.ts` con burst concurrente multi-tenant/multi-cámara.
  - assertions de error budget (sin errores) y presupuesto temporal de ejecución.
  - validación de métricas de requests/latencia por tenant y cámara bajo carga.
- NH-DP-10: soak test con reporte SLO/SLI:
  - runner `test:soak` en data-plane.
  - reporte markdown automático con resultado `PASS/FAIL`.
  - gate por `error rate` y latencia `p95` configurable por env.
  - `test:soak:record` persiste histórico por run (`.md` + `.json`) y genera índice con deltas vs run previo.
- NH-DP-12: base de Detection Plane y event-plane:
  - endpoints nuevos:
    - `POST /detections/jobs`
    - `GET /detections/jobs/:id`
    - `GET /detections/jobs/:id/results`
    - `POST /detections/jobs/:id/cancel`
    - `GET /cameras/:id/detections`
    - `GET /incidents`
    - `GET /incidents/:id`
    - `GET /incidents/:id/evidence`
    - `GET /events/ws-token`
    - `GET /events/stream` (SSE fallback)
  - tablas nuevas:
    - `DetectionJob`
    - `DetectionObservation`
    - `Track`
    - `TrackPoint`
    - `ScenePrimitiveEvent`
    - `IncidentEvent`
    - `IncidentEvidence`
    - `InferenceProviderConfig`
    - `InferenceNodeSnapshot`
  - `CameraProfile` extendido con `zoneMap`, `homography`, `sceneTags`, `rulesProfile`.
  - nuevo servicio `apps/event-gateway` para WS/SSE y `infra/docker-compose.yml` para despliegue on-prem.
- NH-DP-13: ejecución inicial de pipeline de detección:
  - cuando `DETECTION_BRIDGE_URL` está definido, `POST /detections/jobs` dispara ejecución inline.
  - transición de estado de job `queued -> running -> succeeded|failed`.
  - persiste `DetectionObservation`, `Track`, `TrackPoint`, `ScenePrimitiveEvent`, `IncidentEvent`, `IncidentEvidence`.
- NH-DP-14: dispatch Temporal desde API:
  - en `DETECTION_EXECUTION_MODE=temporal`, `POST /detections/jobs` llama `POST {DETECTION_TEMPORAL_DISPATCH_URL}/v1/workflows/detection-jobs`.
  - si el dispatch responde `200`, el job conserva estado `queued` y persiste `workflowId`/`runId`.
  - si el dispatch falla, el job pasa a `failed` con `errorCode=TEMPORAL_DISPATCH_ERROR`.
- NH-DP-15: callback de resultados Temporal -> API:
  - nuevos endpoints internos protegidos por `x-detection-callback-secret`:
    - `POST /internal/detections/jobs/:id/complete`
    - `POST /internal/detections/jobs/:id/fail`
  - `detection-worker` reporta cierre de job al API:
    - éxito: persiste observaciones/tracks/incidentes/evidencia y marca `succeeded`.
    - falla: marca `failed` con `errorCode=DETECTION_WORKFLOW_ERROR` (u otro provisto).
- NH-DP-16: publicación realtime de detección/incidentes:
  - API publica en `event-gateway` al cerrar jobs:
    - `eventType=detection.job` para `succeeded|failed`
    - `eventType=incident` por cada incidente persistido
  - `event-gateway` agrega contrato interno:
    - `POST /internal/events/publish` con `x-event-publish-secret`
  - `event-gateway` SSE soporta replay corto:
    - `GET /events/stream?replay=<n>&topics=<csv>`
- NH-028: ciclo de vida de sesiones de stream:
  - `GET /stream-sessions`
  - `GET /stream-sessions/:id`
  - `POST /stream-sessions/:id/activate`
  - `POST /stream-sessions/:id/end`
  - `POST /cameras/:id/stream-token` ahora devuelve también `session`.

### Changed

- `POST /cameras/:id/stream-token`:
  - Antes: `{ token, expiresAt }`
  - Ahora: `{ token, expiresAt, session }`

### Compatibility

- Compatibilidad backward preservada:
  - Rutas legacy sin prefijo (`/auth/*`, `/cameras/*`, etc.) siguen activas.
  - Campo `token` y `expiresAt` se mantiene en stream-token.

### Notes

- `/v1` es alias de compatibilidad actual; la migración de fronts puede hacerse incrementalmente.
- `READINESS_FORCE_FAIL=1` está disponible para testear fallback de readiness en entorno local.
