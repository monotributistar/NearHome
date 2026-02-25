# Backlog Ejecutable (Issues Locales)

## Cómo usar este backlog

- Estado sugerido: `todo`, `in_progress`, `blocked`, `done`.
- Prioridad: `P0`, `P1`, `P2`.
- Cada item tiene criterio de aceptación verificable.

## P0 - Seguridad, calidad y DX (inmediato)

### NH-001 (P0) - Estandarizar errores API

- Estado: `done`
- Scope:
  - Unificar respuesta de error: `{ code, message, details? }`.
  - Aplicar en auth, tenant, cameras, plans, events.
- Aceptación:
  - 400/401/403/404/500 devuelven shape consistente.
  - Documentado en `docs/CONTRATOS_COMPONENTES.md`.

### NH-002 (P0) - Rate limit en login

- Estado: `done`
- Scope:
  - Limitar `POST /auth/login` por IP y ventana temporal.
- Aceptación:
  - Exceso de requests devuelve 429 con error estándar.
  - Configurable por env (`LOGIN_RATE_LIMIT_*`).

### NH-003 (P0) - Validación estricta de X-Tenant-Id

- Estado: `done`
- Scope:
  - Garantizar enforcement centralizado para endpoints tenant-scoped.
- Aceptación:
  - Sin `X-Tenant-Id`: 400.
  - Tenant inválido/no miembro: 403.
  - Cobertura de tests en endpoints críticos.

### NH-004 (P0) - Tests backend multi-tenant isolation

- Estado: `done`
- Scope:
  - Casos cruzados de lectura/escritura entre tenants.
- Aceptación:
  - Suite falla si un usuario accede datos de otro tenant.
  - Integrado en `pnpm test` (o `pnpm test:api`).

### NH-005 (P0) - Tests backend RBAC por rol

- Estado: `done`
- Scope:
  - `tenant_admin`, `monitor`, `client_user` sobre cámaras, users, subscription.
- Aceptación:
  - Matriz de permisos cubierta por tests.
  - Casos de denegación verifican 403.

### NH-006 (P0) - Smoke E2E Admin

- Estado: `done`
- Scope:
  - Login, selector tenant, crear/editar/eliminar cámara.
- Aceptación:
  - Flujo green en headless.
  - Ejecutable local con `pnpm test:e2e:admin`.

### NH-007 (P0) - Smoke E2E Portal

- Estado: `done`
- Scope:
  - Login, listar cámaras, abrir detalle, pedir stream-token.
- Aceptación:
  - Flujo green en headless.
  - Ejecutable local con `pnpm test:e2e:portal`.

### NH-008 (P0) - Lint/format unificado

- Estado: `done`
- Scope:
  - ESLint + Prettier (o Biome) en apps/packages.
- Aceptación:
  - `pnpm lint` y `pnpm format:check` disponibles.
  - Reglas mínimas para TS/React/imports.

### NH-009 (P0) - Script setup local

- Estado: `done`
- Scope:
  - `pnpm setup` para instalar deps, copiar envs y resetear db.
- Aceptación:
  - Onboarding funcional en 1 comando + `pnpm dev`.

### NH-010 (P0) - PR checklist

- Estado: `todo`
- Scope:
  - Plantilla PR con checks de RBAC/tenant/contracts/tests.
- Aceptación:
  - Archivo de plantilla en repo (`.github/PULL_REQUEST_TEMPLATE.md`).

### NH-021 (P0) - TDD administración de usuarios (API)

- Estado: `done`
- Scope:
  - Tests de integración para `POST /users` y `PUT /users/:id` con RBAC.
- Aceptación:
  - `tenant_admin` crea y edita usuarios en tenant activo.
  - `monitor` recibe 403 en creación/edición.

### NH-022 (P0) - E2E flujo Admin Users

- Estado: `done`
- Scope:
  - Flujo de UI admin: login, alta de usuario y edición de rol.
- Aceptación:
  - Suite ejecutable con `pnpm test:e2e:admin`.
  - Cobertura explícita en `docs/E2E.md`.

### NH-023 (P0) - E2E RBAC Admin para monitor

- Estado: `done`
- Scope:
  - Validar restricciones de UI para rol `monitor` en admin.
- Aceptación:
  - No puede crear/editar/borrar cámaras.
  - No puede crear usuarios.
  - No puede activar plan en subscriptions.

### NH-024 (P0) - E2E RBAC Admin para client_user

- Estado: `done`
- Scope:
  - Validar restricciones de UI para rol `client_user` en admin.
- Aceptación:
  - No puede crear/editar/borrar cámaras.
  - No puede activar plan en subscriptions.

### NH-025 (P0) - Perfil interno de cámara (API + dominio)

- Estado: `done`
- Scope:
  - Extender entidad cámara con `description`.
  - Crear `CameraProfile` interno para proxy/storage/detectores.
  - Endpoints `GET/PUT /cameras/:id/profile`.
- Aceptación:
  - Toda cámara activa tiene perfil interno.
  - Solo `tenant_admin` puede editar perfil.
  - Perfil expone estado operativo (`pending|ready|error`) y health/error.
  - Si la configuración queda incompleta, cae automáticamente a `pending`.
  - Cobertura API en tests de integración.

### NH-026 (P0) - E2E flujo de configuración de cámara y perfil interno

- Estado: `done`
- Scope:
  - Flujo admin: crear cámara con descripción, abrir detalle y configurar perfil interno.
- Aceptación:
  - Suite E2E valida persistencia de campos de perfil.
  - Suite E2E valida fallback visual cuando el perfil queda incompleto.
  - Integrado en `pnpm test:e2e:admin`.

### NH-027 (P0) - Ciclo de vida de cámara (API + Admin + E2E)

- Estado: `done`
- Scope:
  - Modelo de ciclo de vida por cámara (`draft`, `provisioning`, `ready`, `error`, `retired`).
  - Historial de transiciones y snapshot de salud.
  - Endpoints de lifecycle (`/lifecycle`, `/validate`, `/retire`, `/reactivate`, `/health`).
  - UI Admin en detalle de cámara para acciones de ciclo.
- Aceptación:
  - Transición `draft -> ready` validada por API test y E2E.
  - `monitor` no puede ejecutar `retire/reactivate` (403).
  - Historial visible en detalle de cámara.

### NH-028 (P1) - Bloque stream session y seguimiento operativo

- Estado: `done`
- Scope:
  - Modelo de sesión de stream (`requested`, `issued`, `active`, `ended`, `expired`).
  - Trazabilidad por cámara y actor (quién abrió/cerró sesión).
  - Estados de seguimiento operativo (`tracking`) desacoplados del token.
- Aceptación:
  - Endpoint de creación/cierre/listado de sesiones mock.
  - Reglas RBAC y tenant-scope cubiertas en tests.
  - Contrato documentado para futura integración con data-plane.

## P1 - Observabilidad, contratos, dominio

### NH-011 (P1) - Request ID + logs estructurados

- Estado: `done`
- Scope:
  - Correlation id por request y logging con contexto.
- Aceptación:
  - Logs contienen `requestId`, `route`, `statusCode`, `latencyMs`, `tenantId?`, `userId?`.

### NH-012 (P1) - Endpoint readiness

- Estado: `done`
- Scope:
  - `GET /readiness` con check de DB.
- Aceptación:
  - Responde no-ok si DB no disponible.

### NH-013 (P1) - Versionado API /v1

- Estado: `done`
- Scope:
  - Namespacing de rutas y compatibilidad con fronts.
- Aceptación:
  - Admin/Portal funcionando con `/v1`.

### NH-014 (P1) - API changelog

- Estado: `done`
- Scope:
  - Documento de cambios de contratos.
- Aceptación:
  - `docs/API_CHANGELOG.md` creado y enlazado en README.

### NH-015 (P1) - Asignación cámara a usuario (subset)

- Estado: `todo`
- Scope:
  - Modelo simple de asignación para `client_user`.
- Aceptación:
  - `client_user` ve solo cámaras asignadas cuando existan asignaciones.

### NH-016 (P1) - Auditoría básica

- Estado: `done`
- Scope:
  - Registrar acciones críticas (crear/editar/eliminar cámara, cambiar suscripción).
- Aceptación:
  - Tabla audit poblada y endpoint mínimo de consulta admin.

## P2 - Escalado y producción

### NH-017 (P2) - Contrato ControlPlane->DataPlane

- Estado: `todo`
- Scope:
  - Definir interfaces y payloads de integración futura.
- Aceptación:
  - Documento técnico aprobado en `docs/`.

### NH-018 (P2) - Stream-token firmado

- Estado: `todo`
- Scope:
  - Reemplazar token mock por token firmado con expiración y claims.
- Aceptación:
  - Validación de firma + expiración.

### NH-019 (P2) - Migración a Postgres (staging/prod)

- Estado: `todo`
- Scope:
  - Configuración datasource y plan de migración.
- Aceptación:
  - API levantando contra Postgres en entorno staging.

### NH-020 (P2) - CI pipeline

- Estado: `todo`
- Scope:
  - typecheck + tests API + e2e smoke.
- Aceptación:
  - Workflow bloquea merge en fallos.
