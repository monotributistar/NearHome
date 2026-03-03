# Progreso, Cambios y Problemas

## Corte actual

- Fecha de corte: `2026-03-02`
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
- Etapa activa: resiliencia + observabilidad de playback (NH-DP-04) completada
- Etapa activa: adapter de media desacoplado (NH-DP-05) completada
- Etapa activa: process-engine de data-plane (NH-DP-06) completada
- Etapa activa: supervisor de workers process-engine (NH-DP-07) completada
- Etapa activa: playback HLS con segmentos dinámicos + smoke ffmpeg (NH-DP-08A) completada
- Etapa activa: guardrail de concurrencia playback por tenant (NH-DP-08B) completada
- Etapa activa: timeout operativo de playback (NH-DP-08C) completada
- Etapa activa: observabilidad QoS de playback (NH-DP-08D) completada
- Etapa activa: carga multi-tenant con error budget (NH-DP-09) completada
- Etapa activa: soak test con reporte SLO/SLI (NH-DP-10) completada

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
13. Enforcement de entitlements (NH-035):
   - Límite de cámaras por plan en `POST /cameras`.
   - Límite de concurrencia de streams por plan en `POST /cameras/:id/stream-token`.
   - Ventana de retención por plan en `GET /events`.
   - Contrato explícito en `docs/ENTITLEMENTS_CONTRACT.md`.
14. Data-plane cameras + sessions (NH-DP-01/NH-DP-02):
   - Provisioning idempotente por cámara con source profile (`transport`, `codecHint`, `targetProfiles`) y `version`.
   - Session manager por `sid` en data-plane con estados `issued|active|ended|expired`.
   - Sweep de TTL/idle configurable y endpoint de ejecución manual.
   - Métricas de sesiones expuestas en `GET /metrics`.
15. Playback robusto (NH-DP-03):
   - errores tipificados por causa de token, scope, estado de stream, estado de sesión y assets de playback.
   - contrato de errores documentado en `docs/CONTROLPLANE_DATAPLANE_CONTRACT.md`.
   - cobertura de tests de contrato de playback ampliada en data-plane.
16. Playback resiliente y observable (NH-DP-04):
   - retry/backoff configurable para lectura de `index.m3u8` y `segment0.ts`.
   - métricas por `tenant/camera/asset` para requests, errores y reintentos.
   - tests TDD para fallback transitorio de assets y visibilidad de errores por tenant.
17. Adapter de media para data-plane (NH-DP-05):
   - motor de media desacoplado detrás de interfaz `MediaEngine`.
   - `buildApp({ mediaEngine })` habilita inyección de motor real/simulado.
   - test de contrato validando que playback mantiene shape HTTP con engine custom.
18. Process engine para ingesta/transcode (NH-DP-06):
   - soporte `STREAM_MEDIA_ENGINE=process` con worker por stream.
   - comando del worker configurable por env con placeholders de stream.
   - health enriquecido con diagnóstico de workers (`total/running/stopped/failed`).
19. Supervisor de process-engine (NH-DP-07):
   - restart/backoff exponencial para workers con salida por error.
   - preset `ffmpeg-hls` para comando de transcode estandarizado.
   - métricas operativas de workers y restarts.
20. Playback HLS dinámico + smoke real (NH-DP-08A):
   - endpoint dinámico `/playback/:tenantId/:cameraId/segments/:segmentName`.
   - reescritura de `index.m3u8` para asset URLs tokenizadas por segmento.
   - smoke test con ffmpeg real (`lavfi`) para validar fetch de manifiesto + segmento dinámico.
21. Guardrail de concurrencia playback por tenant (NH-DP-08B):
   - límite opcional de sesiones activas en data-plane (`STREAM_MAX_ACTIVE_SESSIONS_PER_TENANT`).
   - rechazo explícito `409 PLAYBACK_TENANT_CAPACITY_EXCEEDED`.
   - validación de no interferencia cross-tenant bajo límite activo.
22. Timeout operativo de playback (NH-DP-08C):
   - timeout de lectura de assets por request (`STREAM_PLAYBACK_READ_TIMEOUT_MS`).
   - error explícito `504 PLAYBACK_ASSET_TIMEOUT` para manifest/segment.
   - preservación del código de timeout (no degradar a 404) en contrato HTTP.
23. Observabilidad QoS de playback (NH-DP-08D):
   - métricas de latencia de serving por tenant/cámara/asset (`nearhome_playback_latency_ms_sum/count`).
   - métrica de requests lentos por umbral (`nearhome_playback_slow_requests_total`).
   - umbral configurable con `STREAM_PLAYBACK_SLOW_MS`.
24. Carga multi-tenant con error budget (NH-DP-09):
   - suite dedicada de carga `stream-gateway.load.spec.ts`.
   - burst concurrente sobre múltiples tenants/cámaras en playback `index.m3u8`.
   - verificaciones de budget: tasa de error y tiempo total de ejecución.
25. Soak test con reporte SLO/SLI (NH-DP-10):
   - runner `scripts/soak-report.ts` con escenario configurable por env.
   - reporte markdown `docs/reports/stream-soak-latest.md` con `PASS/FAIL`.
   - gate operacional por error rate y latencia p95.

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
- `apps/api/src/app.ts`:
  - `ApiDomainError` para errores de dominio de entitlements.
  - enforcement de `maxCameras`, `maxConcurrentStreams`, `retentionDays`.
- `apps/api/prisma/seed.ts`:
  - expansión de seed a 3 tenants con planes `starter/basic/pro`.
- `apps/api/test/control-plane.spec.ts`:
  - suite NH-035 con casos de límites y retención.
- `docs/ENTITLEMENTS_CONTRACT.md`:
  - contrato técnico de cálculo y enforcement.
- `apps/stream-gateway/src/app.ts`:
  - source profile en `/provision` + idempotencia/versionado.
  - tracking de sesiones playback por `sid` + TTL/idle sweep.
  - endpoints `/sessions` y `/sessions/sweep`.
  - nuevas métricas de sesiones.
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - cobertura NH-DP-01/NH-DP-02 (idempotencia, TTL, deprovision cierra sesiones).
- `apps/stream-gateway/src/app.ts`:
  - matriz de validaciones y errores robustos en endpoints de playback.
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - casos NH-DP-03 para errores de token/scope/session/stream/assets.
- `apps/stream-gateway/src/app.ts`:
  - lectura de assets con `retry/backoff` configurable (`STREAM_PLAYBACK_READ_*`).
  - métricas nuevas: `nearhome_playback_requests_total`, `nearhome_playback_errors_total`, `nearhome_playback_read_retries_total`.
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - casos NH-DP-04 para reintentos exitosos en miss transitorio y métricas por tenant/cámara.
- `apps/stream-gateway/src/media-engine.ts`:
  - nuevo adapter `MediaEngine` + implementación mock filesystem.
- `apps/stream-gateway/src/app.ts`:
  - consumo de adapter inyectable con fallback por env `STREAM_MEDIA_ENGINE`.
  - `/health` incluye engine activo para diagnóstico.
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - caso de contrato con engine inyectado (independencia del motor).
- `apps/stream-gateway/src/media-engine.ts`:
  - implementación `createProcessMediaEngine` con lifecycle de workers por cámara.
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - test NH-DP-06 para engine `process` por env y diagnóstico de workers.
- `apps/stream-gateway/src/media-engine.ts`:
  - supervisor de workers con `restartCount`, `lastExit` y backoff configurable.
  - soporte `STREAM_TRANSCODER_PRESET=ffmpeg-hls` y `STREAM_TRANSCODER_DRY_RUN`.
- `apps/stream-gateway/src/app.ts`:
  - métricas de worker engine (`nearhome_media_workers_total`, `nearhome_media_worker_restarts_total`).
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - tests NH-DP-07 para preset ffmpeg y restart/backoff de worker.
- `apps/stream-gateway/src/app.ts`:
  - soporte de playback para rutas de segmento dinámico (`/segments/:segmentName`).
  - reescritura de manifiesto hacia URLs tokenizadas por segmento.
- `apps/stream-gateway/src/media-engine.ts`:
  - `readSegment(scope, segmentName?)` para leer segmento dinámico.
  - preset `ffmpeg-hls` compatible con input sintético `lavfi` en smoke tests.
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - smoke NH-DP-08A con ffmpeg real (si está disponible).
- `apps/stream-gateway/src/app.ts`:
  - enforcement opcional de capacidad máxima de sesiones activas por tenant.
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - tests NH-DP-08B para límite por tenant y aislamiento cross-tenant.
- `apps/stream-gateway/src/app.ts`:
  - timeout explícito en `readWithRetry` y mapeo de error `PLAYBACK_ASSET_TIMEOUT`.
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - tests NH-DP-08C para timeout de manifest y segment.
- `apps/stream-gateway/src/app.ts`:
  - medición de latencia por request de playback y clasificación de request lenta.
- `apps/stream-gateway/test/stream-gateway.spec.ts`:
  - test NH-DP-08D para métricas QoS de latencia/slow requests.
- `apps/stream-gateway/test/stream-gateway.load.spec.ts`:
  - escenario NH-DP-09 de carga concurrente multi-tenant con assertions de budget y métricas.
- `apps/stream-gateway/package.json`:
  - nuevo comando `test:load`.
- `apps/stream-gateway/scripts/soak-report.ts`:
  - ejecución de soak y generación de reporte SLO/SLI.
- `apps/stream-gateway/package.json`:
  - nuevo comando `test:soak`.
- `docs/CONTROLPLANE_DATAPLANE_CONTRACT.md`:
  - contrato actualizado de provision y session tracking.

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
4. `2026-03-01` - flakiness en suite API por SQLite compartido entre archivos.
   - Causa: ejecución paralela de archivos de Vitest con mutaciones concurrentes de DB.
   - Resolución: `apps/api/vitest.config.ts` con `fileParallelism: false`.

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
- `pnpm --filter @app/api test`: `36 passed` (incluye NH-035 + scheduler)
- `pnpm --filter @app/stream-gateway test`: `5 passed`
- `pnpm --filter @app/stream-gateway test`: `5 passed` (incluye métricas + token firmado + mismatch)
- `pnpm --filter @app/stream-gateway test`: `7 passed` (incluye aislamiento + errores claros)
- `pnpm --filter @app/stream-gateway test`: `10 passed` (incluye NH-DP-01/NH-DP-02)
- `pnpm --filter @app/stream-gateway test`: `12 passed` (incluye NH-DP-03 playback robusto)
- `pnpm --filter @app/stream-gateway test`: `14 passed` (incluye NH-DP-04 retry/backoff + métricas playback)
- `pnpm --filter @app/stream-gateway test`: `15 passed` (incluye NH-DP-05 adapter de media)
- `pnpm --filter @app/stream-gateway test`: `16 passed` (incluye NH-DP-06 process engine)
- `pnpm --filter @app/stream-gateway test`: `18 passed` (incluye NH-DP-07 supervisor process-engine)
- `pnpm --filter @app/stream-gateway test`: `19 passed` (incluye NH-DP-08A segmentos dinámicos + smoke ffmpeg)
- `pnpm --filter @app/stream-gateway test`: `21 passed` (incluye NH-DP-08B guardrail por tenant)
- `pnpm --filter @app/stream-gateway test`: `23 passed` (incluye NH-DP-08C timeout operativo)
- `pnpm --filter @app/stream-gateway test`: `24 passed` (incluye NH-DP-08D QoS playback)
- `pnpm --filter @app/stream-gateway test:load`: `1 passed` (NH-DP-09 burst multi-tenant)
- `pnpm --filter @app/stream-gateway test`: `25 passed` (incluye suite NH-DP-09)
- `pnpm --filter @app/stream-gateway test:soak`: `PASS` (reporte generado)
- `pnpm test:e2e:admin`: `7 passed`
- `pnpm test:e2e:portal`: `2 passed`

## Próximo bloque recomendado

1. NH-DP-11: export de resultados de soak a histórico (series temporales) para tendencia.
2. NH-015: asignación de cámaras por `client_user` (subset real y enforcement integral).
3. Endurecimiento e2e multi-tenant para concurrencia de playback (escenarios simultáneos por tenant).
