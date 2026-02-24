# NearHome POC - Plan General

## 1) Objetivo

Construir un control-plane multi-tenant productivo (POC) con:

- `apps/api`: auth, RBAC, tenants, cámaras, planes, suscripción, entitlements, eventos mock.
- `apps/admin`: backoffice con Refine headless.
- `apps/portal`: experiencia cliente/monitor.
- `packages/*`: contratos, cliente API y UI reutilizable.

## 2) Principios de arquitectura

- Separación `Control Plane` (esta iteración) vs `Data Plane` (fase futura).
- Contratos compartidos por Zod en `@app/shared`.
- Tenant scoping obligatorio por `X-Tenant-Id`.
- Permisos en backend (source of truth) + UI ACL (ergonomía).
- Endpoints compatibles con refine simple-rest para listas CRUD.

## 3) Plan por etapas

### Etapa 0 - Bootstrap (completada)

- Monorepo pnpm + turbo.
- Apps: api/admin/portal.
- Packages: shared/api-client/ui.
- Tailwind + daisyUI en ambos frontends.

### Etapa 1 - Núcleo backend (completada)

- Prisma SQLite + schema entidades.
- Auth JWT + middleware de contexto (`userId`, `tenantId`, `role`).
- RBAC por endpoint.
- CRUD cámaras tenant-scoped.
- Plans/subscriptions/entitlements.
- stream-token mock + events mock.
- Seed con datos demo.

### Etapa 2 - Admin Backoffice (completada)

- Login + sesión + selector tenant.
- Refine headless + simple-rest.
- Recursos: tenants, users, memberships, cameras, plans, subscriptions.
- ACL de acciones por rol.

### Etapa 3 - Portal Cliente/Monitor (completada)

- Login + select tenant.
- Cámaras (list + detalle).
- stream-token mock desde detalle.
- Eventos con filtros.
- Cuenta/perfil.

### Etapa 4 - Hardening POC (completada)

- Tests e2e críticos (auth, tenant scope, RBAC).
- Manejo uniforme de errores y códigos.
- Base de auditoría de cambios de cámara por lifecycle log.
- Paginación/filtros extendidos.

### Etapa 5 - Lifecycle de cámara (en progreso)

- Perfil interno por cámara activa (proxy/storage/detectores).
- Estados de lifecycle (`draft/provisioning/ready/error/retired`).
- Transiciones operativas (`validate`, `retire`, `reactivate`).
- Snapshot de salud y timeline en Admin.

### Etapa 6 - Stream session + tracking (siguiente)

- Definir y exponer ciclo de vida de sesión de stream (token/session desacoplado).
- Tracking operativo por cámara (última sesión, fallos, reconexión).
- Contrato control-plane para integración futura con data-plane.

### Etapa 7 - Preparación scale-out (siguiente)

- Extraer módulo auth/tenant/rbac en paquetes internos.
- Versionado de contratos API.
- Diseño de integración con futuro data-plane.

## 4) Criterios de aceptación por release

- Usuario ve solo tenants propios.
- `X-Tenant-Id` scopa datos siempre.
- `client_user` no crea cámaras.
- `monitor` no modifica suscripción/planes.
- Admin y Portal operativos vía `pnpm dev`.

## 5) Backlog inmediato recomendado

1. NH-028 Stream session + tracking operativo.
2. NH-011 Request ID + logs estructurados.
3. NH-014 API changelog versionado.
4. Estrategia de migración a Postgres para staging/prod.
