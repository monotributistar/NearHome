# Contrato de Entitlements

## Objetivo

Definir cómo se calculan y cómo se aplican los entitlements por tenant en el control-plane (`apps/api`).

## Fuente de verdad

- Entitlements derivados en runtime desde:
  - `Subscription` activa del tenant (`status=active`)
  - `Plan` asociado (`limits`, `features`)
- Endpoint de consulta:
  - `GET /tenants/:id/entitlements`
  - `GET /auth/me` incluye `entitlements` del tenant activo (si existe)

## Shape de contrato

```json
{
  "planCode": "starter",
  "limits": {
    "maxCameras": 2,
    "retentionDays": 1,
    "maxConcurrentStreams": 1
  },
  "features": {
    "mediapipe": true,
    "yolo": false,
    "lpr": false
  }
}
```

Schema compartido: `packages/shared/src/index.ts` (`EntitlementsSchema`).

## Enforcement actual (API)

1. `maxCameras`
- Ruta: `POST /cameras`
- Regla: bloquea creación si cámaras no eliminadas (`deletedAt=null`) >= `limits.maxCameras`.
- Error:
  - status: `409`
  - code: `ENTITLEMENT_LIMIT_EXCEEDED`
  - message: `Camera limit reached for active plan`
  - details: `{ limit: "maxCameras", current, maxAllowed, tenantId, planCode }`

2. `maxConcurrentStreams`
- Ruta: `POST /cameras/:id/stream-token`
- Regla: bloquea emisión cuando sesiones `requested|issued|active` no expiradas >= `limits.maxConcurrentStreams`.
- Error:
  - status: `409`
  - code: `ENTITLEMENT_LIMIT_EXCEEDED`
  - message: `Concurrent stream limit reached for active plan`
  - details: `{ limit: "maxConcurrentStreams", current, maxAllowed, tenantId, planCode }`

3. `retentionDays`
- Ruta: `GET /events`
- Regla:
  - si no se envía `from`, se aplica `from = now - retentionDays`.
  - si `from` es más antiguo que la ventana permitida, se rechaza.
- Error:
  - status: `422`
  - code: `ENTITLEMENT_RETENTION_EXCEEDED`
  - message: `Requested date range exceeds plan retention window`
  - details: `{ limit: "retentionDays", maxAllowedDays, minAllowedFrom, requestedFrom, tenantId, planCode }`

## Comportamiento sin suscripción activa

- Si un tenant no tiene `Subscription` activa, `computeEntitlements` devuelve `null`.
- Enforcement actual:
  - no aplica bloqueos por límites en ese tenant.
  - `/tenants/:id/entitlements` responde `{ data: null }`.

## Datos seed actuales

- `Acme Retail`: plan `pro` (`50` cámaras, `30` días, `10` streams)
- `Beta Logistics`: plan `starter` (`2` cámaras, `1` día, `1` stream)
- `Gamma Clinics`: plan `basic` (`10` cámaras, `7` días, `2` streams)

## Test coverage

- Archivo: `apps/api/test/control-plane.spec.ts`
- Casos:
  - entitlements por tenant/plan
  - bloqueo por `maxCameras`
  - bloqueo por `maxConcurrentStreams`
  - enforcement por `retentionDays`
