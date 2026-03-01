# Progreso, Cambios y Problemas

## Corte actual

- Fecha de corte: `2026-03-01`
- Etapa activa: lifecycle de cámara + validación funcional (API/E2E)
- Etapa activa: stream sessions + tracking operativo (NH-028) completada
- Etapa activa: observabilidad base (NH-011) completada
- Etapa activa: versionado `/v1` (NH-013) + changelog API (NH-014) completadas
- Etapa activa: readiness operativa (NH-012) completada
- Etapa activa: auditoría básica de acciones críticas (NH-016) completada
- Etapa activa: administración completa de tenants (NH-029) completada
- Etapa activa: stream-token firmado (NH-018) completada
- Etapa activa: métricas base de data-plane (NH-032) completada
- Etapa activa: contrato ControlPlane/DataPlane (NH-017) completada
- Etapa activa: sync de salud desde data-plane (NH-033) completada
- Etapa activa: scheduler automático de sync health (NH-034) completada

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
5. Observabilidad base de API (NH-011):
   - `x-request-id` propagado/generado en todas las respuestas.
   - Log estructurado `request.summary` con `requestId`, `route`, `method`, `statusCode`, `latencyMs`, `tenantId`, `userId`.
   - Test de contrato para header de correlación.
6. Versionado API y gobernanza de contratos:
   - Compatibilidad de rutas con prefijo `/v1/*` sin romper rutas legacy.
   - Documento de changelog en `docs/API_CHANGELOG.md` con cambios y compatibilidad.
7. Readiness operacional:
   - Endpoint `GET /readiness` con verificación de DB.
   - Retorna `503` en no disponibilidad de DB (incluye reason + requestId).
8. Auditoría básica (NH-016):
   - Nuevo modelo `AuditLog` en DB.
   - Endpoint `GET /audit-logs` (solo `tenant_admin`).
   - Registro de acciones críticas: cámaras (`create/update/delete`, `profile`, lifecycle) y suscripción.
9. Administración de tenants (NH-029):
   - `DELETE /tenants/:id` con soft delete.
   - Admin UI para crear/editar/eliminar tenant.
   - Cobertura API y E2E para flujo CRUD y RBAC.
10. Data-plane hardening inicial:
   - Stream token firmado (HMAC SHA-256) con claims y expiración.
   - Validación en `stream-gateway` por firma + `tenantId` + `cameraId`.
   - Endpoint `GET /metrics` con métricas de estado de streams.
11. Integración contractual y sync operativo:
   - Documento técnico de contrato ControlPlane/DataPlane en `docs/CONTROLPLANE_DATAPLANE_CONTRACT.md`.
   - Endpoint `POST /cameras/:id/sync-health` para sincronizar salud desde data-plane.
   - Worker de probes mock en `stream-gateway` para estados `online|degraded|offline`.
12. Scheduler de sync health (TDD):
   - Loop automático configurable por env para cámaras activas.
   - Reutiliza la misma lógica de `sync-health` manual.
   - Test de integración validando actualización automática de snapshot + lifecycle.

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
- `apps/api/src/app.ts`:
  - Hooks de `onRequest/onResponse` para correlación y logging estructurado.
- `apps/api/src/app.ts`:
  - `rewriteUrl` para compatibilidad `/v1/*`.
- `apps/api/src/app.ts`:
  - endpoint `GET /readiness` con chequeo DB (`SELECT 1`).
- `apps/api/prisma/schema.prisma`:
  - Nuevo modelo `AuditLog`.
- `apps/api/src/app.ts`:
  - Endpoint `GET /audit-logs` + escritura de auditoría en mutaciones críticas.
- `apps/api/src/app.ts`:
  - Endpoint `DELETE /tenants/:id` y filtros para excluir tenants eliminados en auth/listados.
- `apps/admin/src/App.tsx`:
  - Tenants page con acciones inline de update/delete.
- `apps/api/src/app.ts`:
  - Emisión de stream token firmado con claims (`sub`, `tid`, `cid`, `sid`, `exp`, `iat`, `v`).
- `apps/stream-gateway/src/app.ts`:
  - Verificación criptográfica del token de playback.
  - Endpoint `/metrics` (Prometheus text format).
- `apps/stream-gateway/src/app.ts`:
  - Loop de probes mock por stream y health enriquecido por cámara.
- `apps/api/src/app.ts`:
  - Endpoint `/cameras/:id/sync-health` para sincronización con data-plane.
- `apps/api/src/app.ts`:
  - Scheduler de sync health con `STREAM_HEALTH_SYNC_*`.
- `apps/api/test/stream-health-sync.scheduler.spec.ts`:
  - Test de integración del loop automático.

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
- `pnpm --filter @app/api test`: `21 passed`
- `pnpm --filter @app/api test`: `23 passed`
- `pnpm --filter @app/api test`: `25 passed`
- `pnpm --filter @app/api test`: `27 passed`
- `pnpm --filter @app/api test`: `29 passed`
- `pnpm --filter @app/api test`: `30 passed`
- `pnpm --filter @app/api test`: `32 passed`
- `pnpm --filter @app/stream-gateway test`: `5 passed`
- `pnpm --filter @app/stream-gateway test`: `5 passed` (incluye métricas + token firmado + mismatch)
- `pnpm --filter @app/stream-gateway test`: `7 passed` (incluye aislamiento + errores claros)
- `pnpm test:e2e:admin`: `7 passed`
- `pnpm test:e2e:portal`: `2 passed`

## Próximo bloque recomendado

1. NH-019: estrategia de migración a Postgres.
2. NH-017: contrato ControlPlane->DataPlane.
3. NH-018: stream-token firmado.
