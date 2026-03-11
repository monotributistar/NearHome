# Contratos por componente e interfaz

Fecha de actualización: `2026-03-11`

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
- `SubscriptionRequest { id, tenantId, planId, requestedByUserId, status, proofImageUrl, proofFileName, proofMimeType, proofSizeBytes, proofMetadata?, notes?, reviewedByUserId?, reviewNotes?, reviewedAt?, createdAt, updatedAt }`
- `Entitlements { planCode, limits, features }`
- `Event { id, tenantId, cameraId, type, severity, timestamp, payload? }`
- `Household { id, tenantId, name, address?, notes?, isActive, createdByUserId?, createdAt, updatedAt }`
- `HouseholdMember { id, tenantId, householdId, fullName, relationship, phone?, canViewCameras, canReceiveAlerts, isActive, createdByUserId?, createdAt, updatedAt }`

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
- Header opcional `X-Impersonate-Role: tenant_admin|monitor|client_user` (solo `super_admin`, requiere `X-Tenant-Id`)
- Header opcional `X-Request-Id: <requestId>` (si no viene, el backend genera uno)
- 401: token inválido/expirado
- 403: sin membresía o permiso insuficiente
- Respuesta incluye siempre header `x-request-id`

### Error estándar (NH-001)

- Shape único para errores HTTP:
  - `{ code: string, message: string, details?: unknown }`
- Ejemplos de `code`:
  - `VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `INTERNAL_SERVER_ERROR`
  - `ENTITLEMENT_LIMIT_EXCEEDED`, `ENTITLEMENT_RETENTION_EXCEEDED`

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
  - out: `{ user, memberships[], activeTenant?, entitlements?, context? }`
  - `context` incluye:
    - `actorUserId`
    - `effectiveUserId`
    - `effectiveRole`
    - `tenantId`
    - `isImpersonating`
    - `impersonatedRole`

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
- `POST /cameras` (tenant_admin|client_user)
- `GET /cameras/:id`
- `PUT /cameras/:id` (tenant_admin|client_user)
- `DELETE /cameras/:id` (tenant_admin, soft delete)
- `GET /cameras/:id/profile` (tenant roles)
- `PUT /cameras/:id/profile` (tenant_admin)
  - status operativo soportado: `pending|ready|error`
  - fallback automático: si la config queda incompleta => `status=pending`
  - `rulesProfile.notification` gobierna notificaciones por cámara:
    - `enabled`, `minConfidence`, `labels`, `cooldownSeconds`
    - `channels.realtime|webhook|email`
- `GET /cameras/:id/lifecycle` (tenant roles)
  - out: `{ data: { cameraId, currentStatus, lastSeenAt?, lastTransitionAt?, healthSnapshot?, history[] } }`
- `POST /cameras/:id/validate` (tenant_admin|client_user)
  - aplica transición de ciclo de vida (`draft/provisioning/error -> ready`) y registra historial
- `POST /cameras/:id/retire` (tenant_admin)
  - aplica transición `ready/error -> retired`
- `POST /cameras/:id/reactivate` (tenant_admin)
  - aplica transición `retired -> provisioning`
- `POST /cameras/:id/health` (tenant_admin|monitor)
  - upsert de snapshot de salud para pruebas POC
- `POST /cameras/:id/sync-health` (tenant_admin)
  - sincroniza health desde data-plane (`stream-gateway`) y actualiza lifecycle/snapshot

- `GET /plans`
- `GET /subscriptions` (tenant activo)
- `POST /tenants/:id/subscription` (tenant_admin)
- `GET /subscriptions/requests` (`tenant_admin|monitor|client_user`)
  - filtros soportados: `status`, `_start`, `_end`, `_sort`, `_order`
- `POST /subscriptions/requests` (`tenant_admin|client_user`)
  - in: `{ planId, notes?, proof: { imageUrl, fileName, mimeType, sizeBytes, metadata? } }`
  - out: estado inicial `pending_review`
- `PUT /subscriptions/requests/:id/review` (`tenant_admin`)
  - in: `{ status: "approved" | "rejected", reviewNotes? }`
  - si `approved`, activa plan en `subscriptions`
- `GET /tenants/:id/entitlements`
  - contrato detallado en `docs/ENTITLEMENTS_CONTRACT.md`

- `GET /households` (`tenant_admin|monitor|client_user`)
  - filtros soportados: `name`, `_start`, `_end`, `_sort`, `_order`
- `POST /households` (`tenant_admin|client_user`)
  - in: `{ name, address?, notes?, isActive? }`
- `PUT /households/:id` (`tenant_admin|client_user`)
  - in parcial: `{ name?, address?, notes?, isActive? }`
- `DELETE /households/:id` (`tenant_admin|client_user`)
- `GET /households/:id/members` (`tenant_admin|monitor|client_user`)
  - filtros soportados: `_start`, `_end`, `_sort`, `_order`
- `POST /households/:id/members` (`tenant_admin|client_user`)
  - in: `{ fullName, relationship, phone?, canViewCameras?, canReceiveAlerts?, isActive? }`
- `PUT /household-members/:id` (`tenant_admin|client_user`)
  - in parcial: `{ fullName?, relationship?, phone?, canViewCameras?, canReceiveAlerts?, isActive? }`
- `DELETE /household-members/:id` (`tenant_admin|client_user`)

- `POST /cameras/:id/stream-token`
  - out: `{ token, expiresAt, session, playbackUrl? }`
  - crea sesión de stream con tracking (`requested -> issued`)
  - token firmado HMAC SHA-256 con claims: `sub`, `tid`, `cid`, `sid`, `exp`, `iat`, `v`
  - aplica límite por plan `limits.maxConcurrentStreams` (error `409 ENTITLEMENT_LIMIT_EXCEEDED`)
  - propaga a data-plane políticas de recording derivadas de perfil de cámara:
    - `recordingMode` (`continuous|event_only|hybrid|observe_only`)
    - `eventClipPreSeconds`
    - `eventClipPostSeconds`
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
  - aplica ventana de retención por plan `limits.retentionDays`
  - si `from` queda fuera de ventana: `422 ENTITLEMENT_RETENTION_EXCEEDED`
- `GET /cameras/:id/event-clips`
  - out: `{ data: EventClip[], total }`
  - mergea catálogo persistido en API + catálogo de data-plane.
- `POST /cameras/:id/event-clips`
  - in: `{ eventId?, source?, eventTs?, preSeconds?, postSeconds? }`
  - out: `{ data: EventClip & { playbackPath, playbackUrl } }`
  - persiste evento `camera.event_clip` en tabla `Event`.

- `GET /readiness`
  - out ok: `{ ok: true, db: "up", timestamp, requestId }`
  - out fail: `{ ok: false, db: "down", reason, timestamp, requestId }`
  - status: `200` en estado listo, `503` cuando DB no disponible
- `GET /ops/deployment/status` (auth requerido)
  - consolida estado operativo de servicios desplegados y lifecycle de nodos de inferencia
  - out: `{ data: { generatedAt, overallOk, services[], nodes{ total, online, degraded, offline, drained, revokedEstimate, items[] } } }`

### Observabilidad por servicio (estado actual)

- `apps/stream-gateway`: `GET /health`, `GET /health/:tenantId/:cameraId`, `GET /metrics` (Prometheus).
- `apps/api`: `GET /health`, `GET /readiness`, `GET /metrics` (Prometheus), `GET /ops/deployment/status`.
- `apps/event-gateway`: `GET /health` (sin `/metrics` Prometheus en esta etapa).
- `apps/inference-bridge`: `GET /health`, `GET /metrics` (Prometheus, node lifecycle).
- `apps/inference-node-yolo`: `GET /health` (sin `/metrics` Prometheus en esta etapa).
- `apps/inference-node-mediapipe`: `GET /health` (sin `/metrics` Prometheus en esta etapa).
- `apps/detection-worker/dispatcher`: `GET /health` (sin `/metrics` Prometheus en esta etapa).

## 3) Contrato de autorización (RBAC)

Para seguridad de nodos de detección (enrolamiento, credenciales, heartbeat, revocación): ver `docs/NODE_AUTH_CONTRACT.md`.

Roles:

- `super_admin`: visibilidad global de tenants; puede operar globalmente o con contexto impersonado tenant-scoped.
- `tenant_admin`: full sobre tenant.
- `monitor`: lectura de cámaras/eventos; sin cambios de billing.
- `client_user`: lectura de cámaras/eventos.

Matriz mínima:

- `cameras.create|edit`: `tenant_admin|client_user`.
- `cameras.delete`: solo `tenant_admin`.
- `cameras.create`: además sujeto a `limits.maxCameras`.
- `cameras.profile.update`: solo `tenant_admin`.
- `cameras.lifecycle.validate`: `tenant_admin|client_user`.
- `cameras.lifecycle.retire|reactivate`: solo `tenant_admin`.
- `cameras.lifecycle.read`: todos los roles del tenant.
- `stream.sessions.list|get`: `tenant_admin|monitor`; `client_user` solo propias.
- `stream.sessions.activate|end`: `tenant_admin|monitor`; `client_user` solo propias.
- `subscription.activate`: solo `tenant_admin`.
- `subscriptionRequests.list`: `tenant_admin|monitor|client_user`.
- `subscriptionRequests.create`: `tenant_admin|client_user`.
- `subscriptionRequests.review`: solo `tenant_admin`.
- `audit.logs.list`: solo `tenant_admin`.
- `plans.list`: `tenant_admin` y `monitor`.
- `events.list`: todos los roles del tenant.
- `households.list`: `tenant_admin|monitor|client_user`.
- `households.create|edit|delete`: `tenant_admin|client_user`.
- `householdMembers.list`: `tenant_admin|monitor|client_user`.
- `householdMembers.create|edit|delete`: `tenant_admin|client_user`.

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

- Objetivo:
  - Ser la fuente única de composición visual para `apps/admin` y `apps/portal`.
  - Evitar layout ad hoc por pantalla.
- Componentes base disponibles (archivo fuente: `packages/ui/src/index.tsx`):
  - `AppShell`: contenedor de aplicación.
  - `WorkspaceShell`: layout estándar de workspace (header + sidebar + content).
  - `PageCard`: bloque de contenido con título/acciones.
  - `Surface`: contenedor plano auxiliar para secciones internas.
  - `FormGrid`: grilla base para formularios.
  - `FieldLabel`: etiqueta de campo.
  - `DataTable`: wrapper estándar de tabla con scroll horizontal.
  - `PrimaryButton`, `DangerButton`, `TextInput`, `SelectInput`, `Badge`, `Modal`.

#### Contrato de layout (`WorkspaceShell`)

- Input:
  - `product: string`
  - `subtitle?: string`
  - `role?: ReactNode`
  - `tenantSwitcher?: ReactNode`
  - `onLogout?: () => void`
  - `navigation: WorkspaceNavGroup[]`
  - `children`
- `WorkspaceNavGroup`:
  - `{ title: string, items: WorkspaceNavItem[] }`
- `WorkspaceNavItem`:
  - `{ to: string, label: string, icon?: ReactNode }`
- Output/Comportamiento:
  - Header sticky con acciones globales (tenant/rol/logout).
  - Sidebar con navegación agrupada y resaltado de ruta activa por `NavLink`.
  - Área principal única para contenido de la pantalla.

#### Reglas responsive mínimas (obligatorias)

- Formularios:
  - Base: `grid-cols-1`.
  - Desktop: usar `FormGrid` (`md:grid-cols-2`) como default.
  - Formularios densos: permitir `md:grid-cols-12` solo cuando exista justificación funcional.
- Tablas:
  - Siempre dentro de `DataTable` o contenedor con `overflow-x-auto`.
  - No usar tablas sin estrategia de overflow.
- Layout global:
  - Sidebar + content en desktop.
  - Columna única en mobile.

#### Composición permitida (Do)

- Usar `WorkspaceShell` en todas las pantallas autenticadas de admin/portal.
- Usar `PageCard` para delimitar secciones funcionales.
- Usar `FormGrid` + `FieldLabel` para formularios de alta/edición.
- Usar `PrimaryButton`/`DangerButton` en lugar de botones con clases inline ad hoc.
- Usar `Badge` para estados cortos y consistentes.

#### Anti-patrones (Don't)

- No crear navbars/sidebars locales por pantalla fuera de `WorkspaceShell`.
- No mezclar más de un sistema de estilos para el mismo tipo de control en una misma vista.
- No usar `table` directa sin wrapper de overflow.
- No usar combinaciones de clases de botón/input inconsistentes entre pantallas.
- No introducir componentes de UI externos nuevos en apps sin pasar por `@app/ui`.

#### Criterio de aceptación para migraciones UI

- Para cada PR de migración:
  - `pnpm --filter @app/ui typecheck` en verde.
  - `pnpm --filter @app/admin typecheck` y/o `pnpm --filter @app/portal typecheck` en verde según alcance.
  - Sin regresiones visibles de solapamiento en `375`, `768`, `1024`, `1280`.

## 7) Contrato de datos semilla

- 3 tenants
- 3 usuarios
- memberships (admin/monitor/client_user)
- 7 cámaras total
- perfil interno para cada cámara activa
- planes starter/basic/pro
- suscripciones activas:
  - tenant A -> pro
  - tenant B -> starter
  - tenant C -> basic
- 20 eventos mock
