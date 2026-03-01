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
- NH-021 user administration
  - `tenant_admin` puede crear usuario y asignar rol en tenant activo
  - `monitor` no puede crear usuarios
  - `tenant_admin` puede editar `name/isActive/role` en `PUT /users/:id`
  - `monitor` no puede editar usuarios
- NH-029 tenant administration
  - `tenant_admin` puede crear/editar/eliminar tenant (soft delete)
  - tenant eliminado no aparece en `/tenants`
  - `monitor` no puede eliminar tenant
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

## Ejecutar

1. `pnpm db:reset`
2. `pnpm --filter @app/api test`
3. `pnpm --filter @app/stream-gateway test`
