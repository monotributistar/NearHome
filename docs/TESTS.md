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
- NH-011 observabilidad base
  - eco de `x-request-id` cuando viene en request
  - generación automática de `x-request-id` cuando falta

## Ejecutar

1. `pnpm db:reset`
2. `pnpm --filter @app/api test`
