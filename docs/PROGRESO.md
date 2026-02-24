# Progreso, Cambios y Problemas

## Corte actual

- Fecha de corte: `2026-02-24`
- Etapa activa: lifecycle de cámara + validación funcional (API/E2E)
- Etapa activa: stream sessions + tracking operativo (NH-028) completada

## Progreso completado

1. Perfil interno de cámara (proxy/storage/detectores) integrado en API + Admin.
2. Ciclo de vida de cámara implementado:
   - Estados: `draft`, `provisioning`, `ready`, `error`, `retired`.
   - Transiciones por endpoint: `validate`, `retire`, `reactivate`.
   - Historial (`CameraLifecycleLog`) y snapshot de salud (`CameraHealthSnapshot`).
3. Cobertura TDD/E2E:
   - API: casos de transición y RBAC de lifecycle.
   - Admin E2E: flujo `draft -> ready` vía acción `Validate`.
4. Ciclo de vida de sesiones de stream (NH-028):
   - Estados: `requested`, `issued`, `active`, `ended`, `expired`.
   - Endpoints de tracking: listado/detalle/activate/end.
   - Integración en portal para activar/cerrar sesión.

## Cambios técnicos relevantes

- `apps/api/prisma/schema.prisma`:
  - Nuevas entidades `CameraLifecycleLog` y `CameraHealthSnapshot`.
  - Campos lifecycle en `Camera`.
- `apps/api/src/app.ts`:
  - Nuevos endpoints lifecycle.
  - Reglas de transición de estado.
  - Enforcements RBAC para acciones operativas.
- `apps/admin/src/App.tsx`:
  - Sección lifecycle en detalle de cámara.
  - Acciones operativas y timeline de transiciones.
- `apps/portal/src/portal-app.tsx`:
  - Flujo completo de stream session en detalle de cámara (`issue -> activate -> end`).
- `packages/ui/src/index.tsx`:
  - `Badge` ahora propaga atributos HTML (`data-testid`, etc).
- `apps/api/prisma/schema.prisma`:
  - Nuevos modelos `StreamSession` y `StreamSessionTransition`.
- `apps/api/src/app.ts`:
  - Endpoints `GET/POST /stream-sessions*` y emisión de stream token con sesión asociada.

## Problemas encontrados y resolución

1. `2026-02-24` - E2E lifecycle fallaba por selector no detectado.
   - Causa: `Badge` no propagaba props a `span`.
   - Resolución: aceptar/spread de `HTMLAttributes<HTMLSpanElement>`.
2. `2026-02-24` - `pnpm test:e2e:portal` falló al correr en paralelo con admin.
   - Causa: `config.webServer was not able to start` (colisión/arranque concurrente).
   - Resolución: ejecución secuencial de suites para validación estable.
3. `2026-02-24` - API tests de NH-028 disparaban `429` por rate limit de login durante la suite.
   - Causa: demasiados logins acumulados sobre la misma IP de test.
   - Resolución: `x-forwarded-for` único por request en helper de tests.

## Estado de validación (última corrida)

- `pnpm db:reset`: `ok`
- `pnpm --filter @app/api test`: `17 passed`
- `pnpm --filter @app/api test`: `19 passed`
- `pnpm test:e2e:admin`: `6 passed`
- `pnpm test:e2e:portal`: `1 passed`

## Próximo bloque recomendado

1. NH-011: request ID + logs estructurados.
2. NH-014: changelog de contratos API.
3. NH-013: versionado `/v1` sin romper admin/portal.
