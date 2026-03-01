# Plan Streaming Multi-Tenant (TDD)

## Objetivo

Llegar desde el MVP actual a una base de streaming robusta que:

- soporte múltiples tenants y cámaras sin colisiones,
- falle de forma predecible y con errores claros,
- mantenga trazabilidad operativa por stream/sesión,
- permita evolucionar a ingestión real sin reescribir contratos.

## Principios

- TDD estricto por etapa: `red -> green -> refactor`.
- No avanzar etapa sin:
  - tests de la etapa en verde,
  - typecheck en verde,
  - contratos/documentación actualizados.
- Cada cambio de comportamiento requiere test de regresión.

## Etapa 1 (completada): aislamiento y errores base

Estado: `done`

Incluye:

- aislamiento por `tenantId + cameraId` en data-plane,
- deprovision de un tenant sin afectar otro tenant,
- contrato de error consistente en stream-gateway:
  - `{ code, message, details? }`,
- tests de colisión y validación.

Tests clave:

- `isolates same cameraId across different tenants without collisions`
- `returns clear validation and not-found error shapes`

## Etapa 2: sincronización automática de health (control loop)

Estado: `todo`

Objetivo:

- pasar de sync manual (`POST /cameras/:id/sync-health`) a sync automático por scheduler.

TDD:

1. Red:
   - test que valide que una cámara provisionada actualiza snapshot/lifecycle sin intervención manual.
   - test que valide que falla parcial de data-plane no rompe el loop global.
2. Green:
   - scheduler en API (interval configurable) que recorra cámaras activas.
   - backoff y timeout por cámara.
3. Refactor:
   - separar lógica de sync en servicio reusable y testeable.

Criterios de aceptación:

- snapshots actualizados automáticamente,
- auditoría de sync con resultado por cámara,
- no bloqueo global ante errores puntuales.

## Etapa 3: control de concurrencia por tenant/plan

Estado: `todo`

Objetivo:

- evitar colisiones de capacidad entre tenants y cumplir entitlements (`maxConcurrentStreams`).

TDD:

1. Red:
   - tests que exceden concurrencia y esperan `409`/`403` claro.
   - tests cross-tenant para verificar no interferencia.
2. Green:
   - enforcement al emitir stream-token y al activar sesión.
3. Refactor:
   - mover policy a módulo dedicado con matriz de permisos/entitlements.

Criterios de aceptación:

- tenant A no consume cupo de tenant B,
- mensaje de rechazo explícito por límite alcanzado.

## Etapa 4: resiliencia operativa de sesiones

Estado: `todo`

Objetivo:

- endurecer el ciclo de vida de sesiones (`requested|issued|active|ended|expired`) con limpieza y consistencia.

TDD:

1. Red:
   - tests de expiración automática,
   - tests de idempotencia en `end/activate`,
   - tests de carrera (doble activate/end).
2. Green:
   - transiciones atómicas y guardas de estado.
3. Refactor:
   - helpers de transición compartidos y métricas de estado.

Criterios de aceptación:

- no quedan sesiones zombie,
- transiciones inválidas siempre retornan error de dominio claro.

## Etapa 5: data-plane real (ingesta/transcode)

Estado: `todo`

Objetivo:

- reemplazar mock playlist/segment por pipeline real de video.

TDD:

1. Red:
   - tests de contrato (provision/playback/health) sin depender del motor interno.
2. Green:
   - integración con worker real de ingestión y health real.
3. Refactor:
   - separar adaptador de motor de media del contrato HTTP.

Criterios de aceptación:

- contratos actuales preservados,
- observabilidad de latencia/startup/error por stream.

## Gate de calidad por etapa

- `pnpm typecheck`
- `pnpm --filter @app/api test`
- `pnpm --filter @app/stream-gateway test`
- `pnpm test:e2e:admin`
- `pnpm test:e2e:portal`
