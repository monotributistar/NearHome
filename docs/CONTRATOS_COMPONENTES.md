# Contratos por componente e interfaz

## 1) Contrato de dominio compartido (`@app/shared`)

Archivo fuente: `packages/shared/src/index.ts`

### Entidades

- `Tenant { id, name, createdAt }`
- `User { id, email, name, createdAt, isActive }`
- `Membership { id, tenantId, userId, role, createdAt }`
- `Camera { id, tenantId, name, description?, rtspUrl, location?, tags[], isActive, lifecycleStatus, lastSeenAt?, lastTransitionAt?, createdAt, profile? }`
- `CameraProfile { id, cameraId, tenantId, proxyPath, recordingEnabled, recordingStorageKey, detectorConfigKey, detectorResultsKey, detectorFlags, status, configComplete, lastHealthAt?, lastError?, createdAt, updatedAt }`
- `CameraLifecycleLog { id, tenantId, cameraId, fromStatus?, toStatus, event, reason?, actorUserId?, createdAt }`
- `CameraHealthSnapshot { id, tenantId, cameraId, connectivity, latencyMs?, packetLossPct?, jitterMs?, error?, checkedAt }`
- `StreamSession { id, tenantId, cameraId, userId, status, token, expiresAt, issuedAt, activatedAt?, endedAt?, endReason?, createdAt, updatedAt }`
- `StreamSessionTransition { id, streamSessionId, tenantId, fromStatus?, toStatus, event, actorUserId?, createdAt }`
- `AuditLog { id, tenantId, actorUserId?, resource, action, resourceId?, payload?, createdAt }`
- `Plan { id, code, name, limits, features }`
- `Subscription { id, tenantId, planId, status, currentPeriodStart, currentPeriodEnd }`
- `Entitlements { planCode, limits, features }`
- `Event { id, tenantId, cameraId, type, severity, timestamp, payload? }`

### Reglas

- Cualquier cambio de shape debe actualizar Zod + consumidores (api/admin/portal).
- No se aceptan campos implícitos fuera de contrato.

## 2) Contrato HTTP API (`apps/api`)

Base URL: `http://localhost:3001`

Versionado:

- Alias soportado: `http://localhost:3001/v1/*`
- Compatibilidad: rutas sin prefijo siguen activas en esta etapa.

### Seguridad transversal

- Header `Authorization: Bearer <jwt>`
- Header `X-Tenant-Id: <tenantId>` para recursos tenant-scoped
- Header opcional `X-Request-Id: <requestId>` (si no viene, el backend genera uno)
- 401: token inválido/expirado
- 403: sin membresía o permiso insuficiente
- Respuesta incluye siempre header `x-request-id`

### Error estándar (NH-001)

- Shape único para errores HTTP:
  - `{ code: string, message: string, details?: unknown }`
- Ejemplos de `code`:
  - `VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INTERNAL_SERVER_ERROR`

### Formato refine-compatible (listas)

- `GET /resource` => `{ data: [...], total: number }`
- `GET /resource/:id` => `{ data: {...} }`
- `POST/PUT/DELETE` => `{ data: {...} }`

### Endpoints

- `POST /auth/login`
  - in: `{ email, password }`
  - out: `{ accessToken, user }`
  - rate limit por IP:
    - `LOGIN_RATE_LIMIT_MAX` (default `20`)
    - `LOGIN_RATE_LIMIT_WINDOW_MS` (default `60000`)
  - cuando excede límite: `429` con `{ code: "TOO_MANY_REQUESTS", ... }`
- `GET /auth/me`
  - out: `{ user, memberships[], activeTenant?, entitlements? }`

- `GET /tenants`
- `POST /tenants`
- `GET /tenants/:id`
- `PUT /tenants/:id`
- `DELETE /tenants/:id` (tenant_admin, soft delete)

- `GET /users` (tenant-scoped)
- `POST /users` (tenant_admin)

- `GET /memberships` (tenant-scoped)
- `POST /memberships` (tenant_admin)
- `GET /audit-logs` (tenant_admin)
  - filtros opcionales: `resource`, `action`, `_start`, `_end`
  - out: `{ data: AuditLog[], total }`

- `GET /cameras` (tenant-scoped; `_start`, `_end`, `_sort`, `_order`, filtros)
- `POST /cameras` (tenant_admin)
- `GET /cameras/:id`
- `PUT /cameras/:id` (tenant_admin)
- `DELETE /cameras/:id` (tenant_admin, soft delete)
- `GET /cameras/:id/profile` (tenant roles)
- `PUT /cameras/:id/profile` (tenant_admin)
  - status operativo soportado: `pending|ready|error`
  - fallback automático: si la config queda incompleta => `status=pending`
- `GET /cameras/:id/lifecycle` (tenant roles)
  - out: `{ data: { cameraId, currentStatus, lastSeenAt?, lastTransitionAt?, healthSnapshot?, history[] } }`
- `POST /cameras/:id/validate` (tenant_admin)
  - aplica transición de ciclo de vida (`draft/provisioning/error -> ready`) y registra historial
- `POST /cameras/:id/retire` (tenant_admin)
  - aplica transición `ready/error -> retired`
- `POST /cameras/:id/reactivate` (tenant_admin)
  - aplica transición `retired -> provisioning`
- `POST /cameras/:id/health` (tenant_admin|monitor)
  - upsert de snapshot de salud para pruebas POC

- `GET /plans`
- `GET /subscriptions` (tenant activo)
- `POST /tenants/:id/subscription` (tenant_admin)
- `GET /tenants/:id/entitlements`

- `POST /cameras/:id/stream-token`
  - out: `{ token, expiresAt, session, playbackUrl? }`
  - crea sesión de stream con tracking (`requested -> issued`)
  - token firmado HMAC SHA-256 con claims: `sub`, `tid`, `cid`, `sid`, `exp`, `iat`, `v`
- `GET /stream-sessions` (tenant-scoped)
  - filtros: `cameraId`, `status`, `_start`, `_end`, `_sort`, `_order`
  - `client_user` solo ve sesiones propias
- `GET /stream-sessions/:id` (tenant-scoped)
  - out: `{ data: { ...session, history[] } }`
- `POST /stream-sessions/:id/activate`
  - transición `issued -> active`
- `POST /stream-sessions/:id/end`
  - transición `issued|active -> ended`
  - `client_user` solo puede cerrar sesiones propias

- `GET /events?cameraId=&from=&to=`
  - out: `{ data: Event[], total }`

- `GET /readiness`
  - out ok: `{ ok: true, db: "up", timestamp, requestId }`
  - out fail: `{ ok: false, db: "down", reason, timestamp, requestId }`
  - status: `200` en estado listo, `503` cuando DB no disponible

## 3) Contrato de autorización (RBAC)

Roles:

- `tenant_admin`: full sobre tenant.
- `monitor`: lectura de cámaras/eventos; sin cambios de billing.
- `client_user`: lectura de cámaras/eventos.

Matriz mínima:

- `cameras.create|edit|delete`: solo `tenant_admin`.
- `cameras.profile.update`: solo `tenant_admin`.
- `cameras.lifecycle.validate|retire|reactivate`: solo `tenant_admin`.
- `cameras.lifecycle.read`: todos los roles del tenant.
- `stream.sessions.list|get`: `tenant_admin|monitor`; `client_user` solo propias.
- `stream.sessions.activate|end`: `tenant_admin|monitor`; `client_user` solo propias.
- `subscription.activate`: solo `tenant_admin`.
- `audit.logs.list`: solo `tenant_admin`.
- `plans.list`: `tenant_admin` y `monitor`.
- `events.list`: todos los roles del tenant.

## 4) Contrato frontend-admin (`apps/admin`)

- Refine usa data provider REST contra API.
- AuthProvider:
  - persiste `nearhome_access_token`
  - redirige a `/login` en 401
- AccessControlProvider:
  - evalúa `can({resource,action})` por rol en tenant activo
- UI debe ocultar acciones no permitidas (sin reemplazar control backend).

## 5) Contrato frontend-portal (`apps/portal`)

- No usa Refine.
- Usa `@app/api-client`.
- Estado de sesión:
  - `nearhome_access_token`
  - `nearhome_active_tenant`
- En cada request autenticado: `Authorization + X-Tenant-Id`.
- En 401: limpiar sesión y redirigir `/login`.

## 6) Contrato de paquetes internos

### `@app/api-client`

- `ApiClient({ baseUrl, getToken, getTenantId, onUnauthorized })`
- Métodos: `get/post/put/delete`
- Debe ser agnóstico de framework.

### `@app/ui`

- Componentes base con clases semánticas daisyUI.
- Primitivas complejas sin lock-in (estilo shadcn/Radix).

## 7) Contrato de datos semilla

- 2 tenants
- 3 usuarios
- memberships (admin/monitor/client_user)
- 7 cámaras total
- perfil interno para cada cámara activa
- planes basic/pro
- suscripción activa en tenant A
- 20 eventos mock
