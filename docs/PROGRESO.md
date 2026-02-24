# Progreso, Cambios y Problemas

## Corte actual

- Fecha de corte: `2026-02-24`
- Etapa activa: lifecycle de cámara + validación funcional (API/E2E)

## Progreso completado

1. Perfil interno de cámara (proxy/storage/detectores) integrado en API + Admin.
2. Ciclo de vida de cámara implementado:
   - Estados: `draft`, `provisioning`, `ready`, `error`, `retired`.
   - Transiciones por endpoint: `validate`, `retire`, `reactivate`.
   - Historial (`CameraLifecycleLog`) y snapshot de salud (`CameraHealthSnapshot`).
3. Cobertura TDD/E2E:
   - API: casos de transición y RBAC de lifecycle.
   - Admin E2E: flujo `draft -> ready` vía acción `Validate`.

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
- `packages/ui/src/index.tsx`:
  - `Badge` ahora propaga atributos HTML (`data-testid`, etc).

## Problemas encontrados y resolución

1. `2026-02-24` - E2E lifecycle fallaba por selector no detectado.
   - Causa: `Badge` no propagaba props a `span`.
   - Resolución: aceptar/spread de `HTMLAttributes<HTMLSpanElement>`.
2. `2026-02-24` - `pnpm test:e2e:portal` falló al correr en paralelo con admin.
   - Causa: `config.webServer was not able to start` (colisión/arranque concurrente).
   - Resolución: ejecución secuencial de suites para validación estable.

## Estado de validación (última corrida)

- `pnpm db:reset`: `ok`
- `pnpm --filter @app/api test`: `17 passed`
- `pnpm test:e2e:admin`: `6 passed`
- `pnpm test:e2e:portal`: `1 passed`

## Próximo bloque recomendado

1. NH-028: ciclo de vida de sesión de stream (`requested/issued/active/ended/expired`).
2. Tracking operativo por cámara desacoplado del token de stream.
3. E2E admin/portal para abrir/cerrar sesión de stream y validar auditoría mínima.
