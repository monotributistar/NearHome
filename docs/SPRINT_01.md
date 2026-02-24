# Sprint 01 (P0 Core)

## Estado

- `done`

## Objetivo

Cerrar el mínimo de hardening y calidad para operar el POC con menor riesgo en multi-tenant + RBAC.

## Alcance comprometido

- NH-001 Estandarizar errores API
- NH-003 Validación estricta X-Tenant-Id
- NH-004 Tests multi-tenant
- NH-005 Tests RBAC
- NH-009 Script setup local

## Orden de ejecución

1. NH-001
2. NH-003
3. NH-004
4. NH-005
5. NH-009

## Dependencias

- NH-004 y NH-005 dependen de NH-001/003 para assertions estables.

## Riesgos

- Cambios de contrato de error pueden romper flujos front si no se conserva compatibilidad.
- Tests pueden requerir refactor de inicialización de DB para entornos aislados.

## Definition of Done del sprint

- Todos los ítems en estado `done`.
- `pnpm typecheck` green.
- Tests nuevos ejecutando local.
- Documentación de contratos actualizada.
