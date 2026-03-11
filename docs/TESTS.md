# Test Strategy (P0)

## API integration tests

Archivo: `apps/api/test/control-plane.spec.ts`

Cobertura incluida:

- NH-004 multi-tenant isolation
  - 400 cuando falta `X-Tenant-Id` en rutas tenant-scoped
  - 403 cuando el usuario no pertenece al tenant del header
  - 404 para recursos de tenant ajeno (no filtración de existencia)
- NH-005 RBAC
  - `tenant_admin` puede crear cámara
  - `client_user` no puede crear cámara
  - `monitor` no puede cambiar suscripción
- NH-015 asignación cámara a usuario (subset)
  - `client_user` mantiene visibilidad completa cuando no tiene asignaciones activas
  - con asignaciones activas, `client_user` ve solo cámaras permitidas
  - acceso a detalle de cámara no asignada devuelve `404`
- NH-021 user administration
  - `tenant_admin` puede crear usuario y asignar rol en tenant activo
  - `monitor` no puede crear usuarios
  - `tenant_admin` puede editar `name/isActive/role` en `PUT /users/:id`
  - `monitor` no puede editar usuarios
- NH-029 tenant administration
  - `tenant_admin` puede crear/editar/eliminar tenant (soft delete)
  - tenant eliminado no aparece en `/tenants`
  - `monitor` no puede eliminar tenant
- NH-035 superadmin + switch de contexto
  - `super_admin` puede impersonar rol tenant-scoped vía `X-Impersonate-Role`
  - contexto impersonado restringe permisos (ej: `monitor` no crea cámaras)
  - auditoría registra actor real y contexto efectivo en `payload._auth`
- NH-036 membresías N:M operador/customer
  - `operator` puede pertenecer a múltiples tenants y operar en cada tenant asociado
  - `customer` puede pertenecer a múltiples tenants (role alias `customer -> client_user`)
  - acceso con `X-Tenant-Id` fuera de membresía devuelve `403`
- NH-037 gestión de roles y memberships
  - `super_admin` puede cambiar roles de un usuario en distintos tenants (vía contexto `X-Tenant-Id`)
  - `tenant_admin` no puede editar usuarios fuera de su tenant (`403`)
- NH-039 zonificación operador
  - por default `monitor` ve todas las cámaras del tenant
  - con `camera-assignments` activos, el listado/detalle se restringe a allowlist
- NH-040 domicilios y miembros cliente
  - `client_user` puede crear/listar/editar/eliminar `households` en su tenant activo
  - `client_user` puede crear/listar/editar/eliminar `household-members` asociados al domicilio
  - `monitor` no puede crear domicilios (`403`)
- NH-041 onboarding de cámara RTSP en app cliente
  - `client_user` puede crear/editar cámara (`POST/PUT /cameras`) y ejecutar validación inicial (`POST /cameras/:id/validate`)
  - `GET /cameras/:id/lifecycle` expone `healthSnapshot` legible para monitoreo en portal
  - `monitor` mantiene restricción de alta de cámaras (`403`)
- NH-042 notificaciones por reglas tenant/cámara
  - `rulesProfile.notification` dispara entregas por `realtime/webhook/email` al cerrar detecciones con incidente
  - `GET /notifications/deliveries` expone historial tenant-scoped por cámara/canal/estado
  - cobertura de publish realtime (`notification.sent`, `notification.email_queued`) + envío webhook mockeado
- NH-043 suscripción cliente con comprobante
  - `client_user` puede crear `POST /subscriptions/requests` con metadata de comprobante y estado `pending_review`
  - `tenant_admin` puede revisar `PUT /subscriptions/requests/:id/review` (`approved|rejected`)
  - aprobación materializa plan activo en `GET /subscriptions`
  - `monitor` no puede revisar solicitudes (`403`)
- NH-025 camera internal profile
  - crear cámara activa genera `profile` interno automáticamente
  - `tenant_admin` puede configurar `PUT /cameras/:id/profile`
  - `monitor` no puede configurar perfil interno (403)
  - si la config queda incompleta, el perfil cae a `pending` con `configComplete=false`
- NH-027 camera lifecycle
  - transición `draft -> ready` con `POST /cameras/:id/validate`
  - `monitor` no puede `retire/reactivate` (403)
- NH-028 stream sessions lifecycle
  - emisión de token crea sesión `issued`
  - transición `issued -> active -> ended`
  - `client_user` no puede finalizar sesiones ajenas
- NH-035 entitlement enforcement
  - `/tenants/:id/entitlements` devuelve límites por plan real de cada tenant
  - `POST /cameras` bloquea cuando excede `maxCameras` (`409 ENTITLEMENT_LIMIT_EXCEEDED`)
  - `POST /cameras/:id/stream-token` bloquea cuando excede `maxConcurrentStreams` (`409 ENTITLEMENT_LIMIT_EXCEEDED`)
  - límite de concurrencia de tenant A no impacta tenant B (aislamiento cross-tenant)
  - `GET /events` bloquea `from` fuera de `retentionDays` (`422 ENTITLEMENT_RETENTION_EXCEEDED`)
- NH-016 auditoría básica
  - `tenant_admin` obtiene logs en `GET /audit-logs`
  - se registran acciones críticas (`camera.create`, `subscription.set_plan`)
  - `monitor` no puede consultar auditoría (403)
- NH-011 observabilidad base
  - eco de `x-request-id` cuando viene en request
  - generación automática de `x-request-id` cuando falta
- NH-013 versionado API
  - login/me funcionando en `/v1/auth/*`
  - rutas tenant-scoped funcionando en `/v1/*`
- NH-012 readiness
  - `GET /readiness` devuelve `200` con `db=up`
  - devuelve `503` en modo de falla forzada (`READINESS_FORCE_FAIL=1`)
- NH-DP-12 detection plane base
  - `POST /v1/detections/jobs` crea job tenant-scoped (`tenant_admin|monitor`)
  - `GET /v1/detections/jobs/:id` y `GET /v1/detections/jobs/:id/results` (tenant-scoped)
  - `POST /v1/detections/jobs/:id/cancel` cancela job abierto
  - `GET /v1/events/ws-token` emite token corto para realtime
  - `GET /v1/incidents` lista incidentes tenant-scoped
  - `client_user` no puede crear jobs de detección (403)
- NH-DP-13 ejecución pipeline detección (inline bridge)
  - job `queued` pasa a `running/succeeded`
  - persistencia de `DetectionObservation` + `IncidentEvent` + `IncidentEvidence`
  - validación de inferencia mock bridge (`/v1/infer`) y evidencia consultable
- NH-DP-14 dispatch Temporal desde API
  - modo `temporal` envía dispatch a `/v1/workflows/detection-jobs` y persiste `workflowId`/`runId`
  - fallback de error marca job `failed` con `TEMPORAL_DISPATCH_ERROR`
- NH-DP-15 callback de resultados Temporal -> API
  - callback `complete` persiste detecciones/incidentes y deja job `succeeded`
  - callback `fail` marca job `failed` con código de error
  - endpoint interno rechaza requests sin secret (`401`)
- NH-DP-16 publicación realtime detección/incidentes
  - callback `complete` publica `detection.job` e `incident` hacia event-gateway
  - callback `fail` publica `detection.job` con estado `failed`
  - assertions por payload publicado (`jobId`, `status`, `incident.type`)
- NH-DP-17 perfil de detección por cámara
  - `GET /cameras/:id/detection-profile` devuelve perfil tenant-scoped
  - `PUT /cameras/:id/detection-profile` permitido para `tenant_admin`; `monitor` recibe `403`
- NH-DP-18 catálogo de modelos operativo
  - `POST/PUT /ops/model-catalog` permitido solo para superuser
  - `GET /ops/model-catalog` lista entradas filtrables por provider/task/quality/status

## Event-gateway tests

Archivo: `apps/event-gateway/test/app.spec.ts`

- Rechazo de publish sin secret (`401`)
- Publish aceptado (`202`) y replay por SSE (`/events/stream?replay=1&topics=detection&once=1`)

## E2E portal/admin (Playwright)

Archivos: `e2e/tests/*.spec.ts`

- NH-038 UX errores accionables en cámaras
  - smoke admin/portal siguen en verde con nueva capa de error handling (`code|message|details`) en vistas de cámaras

- NH-056 smoke portal unificado (cliente)
  - login `client_user` + alta de cámara RTSP desde portal
  - validación de cámara + stream token + ciclo de sesión (`issued -> active -> ended`)
  - verificación de realtime con tópico `notification` por defecto
  - creación de solicitud de suscripción con comprobante (`pending_review`)

- NH-043 e2e comercial admin
  - creación de solicitud `subscriptions/requests` vía cliente (API)
  - revisión/aprobación en UI admin (`/commercial/subscriptions`)
  - verificación de transición `pending_review -> approved`
  - RBAC: `monitor` ve solicitudes pero sin acciones de review (`Aprobar/Rechazar`)

- NH-031 aislamiento fuerte de cámaras multi-tenant (10 cámaras)
  - alta de 3 tenants y siembra de 10 cámaras (mock + reales opcionales por env `E2E_REAL_CAM1_RTSP`/`E2E_REAL_CAM2_RTSP`)
  - validación API de aislamiento por tenant para `monitor` y `client_user`
  - validación UI en Portal: cambio de tenant, visibilidad correcta y no filtración de cámaras de otros tenants
  - validación de acceso a detalle de cámara visible y bloqueo de tenant no asignado

## Data-plane integration tests

Archivo: `apps/stream-gateway/test/stream-gateway.spec.ts`

Cobertura incluida:

- NH-DP-01/NH-DP-02
  - idempotencia de `POST /provision` y versionado por cámara
  - aislamiento multi-tenant para `tenantId+cameraId`
  - lifecycle de sesiones playback (`active|ended|expired`) y sweep
- NH-DP-03 playback robusto
  - errores tipificados por token/scope/sesión/estado stream/assets
  - stream deprovisioned devuelve `410 PLAYBACK_STREAM_STOPPED`
- NH-DP-04 resiliencia/observabilidad playback
  - retries con backoff ante miss transitorio de manifest
  - métricas por tenant/cámara para requests, errores y reintentos
- NH-DP-05 adapter de media
  - inyección de `MediaEngine` custom y verificación de contrato HTTP de playback sin acoplamiento al motor
- NH-DP-06 process engine
  - validación de `STREAM_MEDIA_ENGINE=process` con worker por stream
  - verificación de diagnóstico de workers en `GET /health`
- NH-DP-07 process supervisor
  - preset `ffmpeg-hls` en modo `dry-run` para validar comando de transcode
  - restart/backoff automático de worker con límite y observabilidad de reinicios
- NH-DP-08A playback real compatible con HLS dinámico
  - smoke test con ffmpeg real (si está disponible) usando source `lavfi`
  - validación de manifiesto reescrito y fetch de segmento dinámico en `/segments/:segmentName`
- NH-DP-08B guardrail de concurrencia por tenant
  - límite opcional de sesiones activas playback por tenant (`STREAM_MAX_ACTIVE_SESSIONS_PER_TENANT`)
  - rechazo explícito `409 PLAYBACK_TENANT_CAPACITY_EXCEEDED`
  - validación de no interferencia cross-tenant bajo límite activo
- NH-DP-08C timeout operativo de playback
  - timeout explícito de lectura de assets (`STREAM_PLAYBACK_READ_TIMEOUT_MS`)
  - retorno de `504 PLAYBACK_ASSET_TIMEOUT` para manifest y segment
  - error observado también en métricas por `code`
- NH-DP-08D QoS observable de playback
  - métricas de latencia (`nearhome_playback_latency_ms_sum/count`) por tenant/cámara/asset
  - contador de requests lentos (`nearhome_playback_slow_requests_total`) con umbral configurable
  - validación de observabilidad QoS mediante adapter con latencia inducida

## Data-plane load test (NH-DP-09)

Archivo: `apps/stream-gateway/test/stream-gateway.load.spec.ts`

Cobertura incluida:

- ráfaga multi-tenant/multi-cámara de playback concurrente sobre `index.m3u8`
- error budget de prueba (0 errores en burst de referencia)
- verificación de conteo de requests y observaciones de latencia por tenant/cámara en métricas
- presupuesto temporal de ejecución del burst para detectar regresiones severas

## Ejecutar

1. `pnpm db:reset`
2. `pnpm --filter @app/api test`
3. `pnpm --filter @app/stream-gateway test`
4. `pnpm --filter @app/stream-gateway test:load`
5. `pnpm --filter @app/stream-gateway test:soak`
6. `pnpm test:stream:soak:record`

## Data-plane soak report (NH-DP-10)

Runner: `apps/stream-gateway/scripts/soak-report.ts`

Salida:

- reporte markdown en `docs/reports/stream-soak-latest.md`
- histórico por run en `docs/reports/history/<runId>.md` y `docs/reports/history/<runId>.json`
- índice de runs en `docs/reports/stream-soak-history.md` con delta vs corrida anterior
- exit code `1` cuando incumple SLO configurados

SLI/SLO evaluados:

- `error rate` global del escenario
- latencia `p95` de serving de playback (`index.m3u8`)

Variables configurables:

- `SOAK_TENANTS`
- `SOAK_CAMERAS_PER_TENANT`
- `SOAK_ROUNDS`
- `SOAK_REQUESTS_PER_CAMERA_PER_ROUND`
- `SOAK_ROUND_DELAY_MS`
- `SOAK_MAX_ERROR_RATE`
- `SOAK_MAX_P95_MS`
- `SOAK_TOKEN_TTL_MS`
- `SOAK_REPORT_PATH`
- `SOAK_RECORD_HISTORY` (`1` por defecto)
- `SOAK_HISTORY_DIR`
- `SOAK_INDEX_PATH`
- `SOAK_HISTORY_ROWS`
