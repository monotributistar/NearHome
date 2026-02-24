# NearHome Roadmap

## Contexto

Este roadmap aplica al repo `/Users/monotributistar/SOURCES/NearHome` y al stack actual de control-plane:

- API Fastify + Prisma
- Admin (Refine headless)
- Portal (React Router)

Queda explícitamente fuera de alcance cualquier implementación con Shinobi.

## Horizonte 0-2 semanas (P0)

### 1. Seguridad base y hardening

- Estandarizar errores API (`code`, `message`, `details?`).
- Rate limit para `/auth/login`.
- Rotación simple de `JWT_SECRET` (documentada).
- Validación estricta de `X-Tenant-Id` en todos los endpoints tenant-scoped.

### 2. Calidad y tests críticos

- Tests backend de aislamiento multi-tenant.
- Tests RBAC por rol (`tenant_admin`, `monitor`, `client_user`).
- Tests smoke de front:
  - Admin: login + CRUD cámara.
  - Portal: login + lista/detalle cámara + stream-token.

### 3. DX y consistencia

- Script único de bootstrap local (`pnpm setup` opcional).
- Linters y formato consistentes en apps/packages.
- Checklist de PR para contratos API + cambios de RBAC.

## Horizonte 2-6 semanas (P1)

### 4. Observabilidad operativa

- Request ID por request.
- Logs estructurados con contexto (`userId`, `tenantId`, `route`, `latency`).
- Endpoint `health` + `readiness`.

### 5. Evolución de contratos

- Versionado API (`/v1`), manteniendo compatibilidad con admin/portal.
- Documento de changelog de contratos (`docs/API_CHANGELOG.md`).
- Cobertura de schemas Zod para payloads de entrada/salida principales.

### 6. Dominio funcional

- Subset de asignación cámara->usuario (hoy client_user ve todas).
- Auditoría básica (tabla/registro de acciones críticas).
- Mejora de filtros y paginación para eventos/cámaras.

## Horizonte 6-10 semanas (P2)

### 7. Preparación para separación Data Plane

- Definir interfaces `ControlPlane -> DataPlane` (sin implementar streaming real).
- Contrato para emisión de stream-token firmado.
- Feature flags para capacidades de detección por plan/tenant.

### 8. Entorno productivo inicial

- Migración a Postgres para staging/prod.
- Estrategia de migraciones versionadas.
- Pipeline CI con:
  - typecheck
  - tests backend
  - tests e2e smoke

## Definición de Done (global)

- Sin regresiones de RBAC/multi-tenant.
- Contratos Zod actualizados y usados en los consumidores.
- Tests mínimos pasando en CI.
- Documentación de operación y rollback actualizada.
