# Backlog Ejecutable (Issues Locales)

## Cómo usar este backlog

- Estado sugerido: `todo`, `in_progress`, `blocked`, `done`.
- Prioridad: `P0`, `P1`, `P2`.
- Cada item tiene criterio de aceptación verificable.

## Sincronización GitHub (corte `2026-03-06`)

Repositorio: `monotributistar/NearHome`

Resumen:
- Issues abiertos: `18`
- Issues cerrados: `1` (`#17`)

Priorización recomendada (fuente: issues abiertos actuales):

1. Hardening de plataforma:
   - `#16` CI/CD con GitHub Actions
   - `#18` SSL/TLS con Let's Encrypt
   - `#19` Rate limiting por tenant
   - `#15` OpenAPI/Swagger
2. Ingesta/detección operativa:
   - `#1` ingesta RTSP/RTSPS directa + frames para detección
   - `#2` test YOLO con video real
   - `#3` API máscaras por cámara
   - `#10` editor visual de zonas
3. Workflow de producto:
   - `#5` incidencias y escalado
   - `#6` WhatsApp Business
   - `#7` Telegram Bot
   - `#8` comandos básicos de agente
4. Experiencia cliente:
   - `#11` botón de pánico
   - `#12` tracking GPS familia
   - `#13` mapa de propiedad
   - `#14` métricas dashboard
5. Capacidad avanzada:
   - `#9` registro de rostros

Notas de alineación:
- Este backlog conserva trazabilidad histórica interna (`NH-*`) y debe convivir con los issues de GitHub.
- Para ejecución de sprint, priorizar la lista GitHub de esta sección por encima de items legacy ya completados.
- Decisión arquitectónica vigente: Shinobi/NVR externo queda fuera de alcance; la detección se resuelve con capa propia (`inference-bridge` + nodos).
- Decisión de identidad vigente: autenticación/autorización con usuarios propios NearHome (RBAC multi-tenant), sin external auth en esta etapa.

## P0 - Seguridad, calidad y DX (inmediato)

### NH-001 (P0) - Estandarizar errores API

- Estado: `done`
- Scope:
  - Unificar respuesta de error: `{ code, message, details? }`.
  - Aplicar en auth, tenant, cameras, plans, events.
- Aceptación:
  - 400/401/403/404/500 devuelven shape consistente.
  - Documentado en `docs/CONTRATOS_COMPONENTES.md`.

### NH-002 (P0) - Rate limit en login

- Estado: `done`
- Scope:
  - Limitar `POST /auth/login` por IP y ventana temporal.
- Aceptación:
  - Exceso de requests devuelve 429 con error estándar.
  - Configurable por env (`LOGIN_RATE_LIMIT_*`).

### NH-003 (P0) - Validación estricta de X-Tenant-Id

- Estado: `done`
- Scope:
  - Garantizar enforcement centralizado para endpoints tenant-scoped.
- Aceptación:
  - Sin `X-Tenant-Id`: 400.
  - Tenant inválido/no miembro: 403.
  - Cobertura de tests en endpoints críticos.

### NH-004 (P0) - Tests backend multi-tenant isolation

- Estado: `done`
- Scope:
  - Casos cruzados de lectura/escritura entre tenants.
- Aceptación:
  - Suite falla si un usuario accede datos de otro tenant.
  - Integrado en `pnpm test` (o `pnpm test:api`).

### NH-005 (P0) - Tests backend RBAC por rol

- Estado: `done`
- Scope:
  - `tenant_admin`, `monitor`, `client_user` sobre cámaras, users, subscription.
- Aceptación:
  - Matriz de permisos cubierta por tests.
  - Casos de denegación verifican 403.

### NH-006 (P0) - Smoke E2E Admin

- Estado: `done`
- Scope:
  - Login, selector tenant, crear/editar/eliminar cámara.
- Aceptación:
  - Flujo green en headless.
  - Ejecutable local con `pnpm test:e2e:admin`.

### NH-007 (P0) - Smoke E2E Portal

- Estado: `done`
- Scope:
  - Login, listar cámaras, abrir detalle, pedir stream-token.
- Aceptación:
  - Flujo green en headless.
  - Ejecutable local con `pnpm test:e2e:portal`.

### NH-008 (P0) - Lint/format unificado

- Estado: `done`
- Scope:
  - ESLint + Prettier (o Biome) en apps/packages.
- Aceptación:
  - `pnpm lint` y `pnpm format:check` disponibles.
  - Reglas mínimas para TS/React/imports.

### NH-009 (P0) - Script setup local

- Estado: `done`
- Scope:
  - `pnpm setup` para instalar deps, copiar envs y resetear db.
- Aceptación:
  - Onboarding funcional en 1 comando + `pnpm dev`.

### NH-010 (P0) - PR checklist

- Estado: `todo`
- Scope:
  - Plantilla PR con checks de RBAC/tenant/contracts/tests.
- Aceptación:
  - Archivo de plantilla en repo (`.github/PULL_REQUEST_TEMPLATE.md`).

### NH-021 (P0) - TDD administración de usuarios (API)

- Estado: `done`
- Scope:
  - Tests de integración para `POST /users` y `PUT /users/:id` con RBAC.
- Aceptación:
  - `tenant_admin` crea y edita usuarios en tenant activo.
  - `monitor` recibe 403 en creación/edición.

### NH-022 (P0) - E2E flujo Admin Users

- Estado: `done`
- Scope:
  - Flujo de UI admin: login, alta de usuario y edición de rol.
- Aceptación:
  - Suite ejecutable con `pnpm test:e2e:admin`.
  - Cobertura explícita en `docs/E2E.md`.

### NH-023 (P0) - E2E RBAC Admin para monitor

- Estado: `done`
- Scope:
  - Validar restricciones de UI para rol `monitor` en admin.
- Aceptación:
  - No puede crear/editar/borrar cámaras.
  - No puede crear usuarios.
  - No puede activar plan en subscriptions.

### NH-024 (P0) - E2E RBAC Admin para client_user

- Estado: `done`
- Scope:
  - Validar restricciones de UI para rol `client_user` en admin.
- Aceptación:
  - No puede crear/editar/borrar cámaras.
  - No puede activar plan en subscriptions.

### NH-029 (P0) - Administración de tenants completa (API + Admin + E2E)

- Estado: `done`
- Scope:
  - `DELETE /tenants/:id` con soft delete.
  - Pantalla admin de tenants con create/update/delete.
  - Cobertura API + E2E para tenant CRUD y RBAC de borrado.
- Aceptación:
  - `tenant_admin` crea/edita/elimina tenant.
  - `monitor` no puede eliminar tenant.
  - Tenant eliminado deja de listarse en `/tenants`.

### NH-025 (P0) - Perfil interno de cámara (API + dominio)

- Estado: `done`
- Scope:
  - Extender entidad cámara con `description`.
  - Crear `CameraProfile` interno para proxy/storage/detectores.
  - Endpoints `GET/PUT /cameras/:id/profile`.
- Aceptación:
  - Toda cámara activa tiene perfil interno.
  - Solo `tenant_admin` puede editar perfil.
  - Perfil expone estado operativo (`pending|ready|error`) y health/error.
  - Si la configuración queda incompleta, cae automáticamente a `pending`.
  - Cobertura API en tests de integración.

### NH-026 (P0) - E2E flujo de configuración de cámara y perfil interno

- Estado: `done`
- Scope:
  - Flujo admin: crear cámara con descripción, abrir detalle y configurar perfil interno.
- Aceptación:
  - Suite E2E valida persistencia de campos de perfil.
  - Suite E2E valida fallback visual cuando el perfil queda incompleto.
  - Integrado en `pnpm test:e2e:admin`.

### NH-027 (P0) - Ciclo de vida de cámara (API + Admin + E2E)

- Estado: `done`
- Scope:
  - Modelo de ciclo de vida por cámara (`draft`, `provisioning`, `ready`, `error`, `retired`).
  - Historial de transiciones y snapshot de salud.
  - Endpoints de lifecycle (`/lifecycle`, `/validate`, `/retire`, `/reactivate`, `/health`).
  - UI Admin en detalle de cámara para acciones de ciclo.
- Aceptación:
  - Transición `draft -> ready` validada por API test y E2E.
  - `monitor` no puede ejecutar `retire/reactivate` (403).
  - Historial visible en detalle de cámara.

### NH-028 (P1) - Bloque stream session y seguimiento operativo

- Estado: `done`
- Scope:
  - Modelo de sesión de stream (`requested`, `issued`, `active`, `ended`, `expired`).
  - Trazabilidad por cámara y actor (quién abrió/cerró sesión).
  - Estados de seguimiento operativo (`tracking`) desacoplados del token.
- Aceptación:
  - Endpoint de creación/cierre/listado de sesiones mock.
  - Reglas RBAC y tenant-scope cubiertas en tests.
  - Contrato documentado para futura integración con data-plane.

## P1 - Observabilidad, contratos, dominio

### NH-011 (P1) - Request ID + logs estructurados

- Estado: `done`
- Scope:
  - Correlation id por request y logging con contexto.
- Aceptación:
  - Logs contienen `requestId`, `route`, `statusCode`, `latencyMs`, `tenantId?`, `userId?`.

### NH-012 (P1) - Endpoint readiness

- Estado: `done`
- Scope:
  - `GET /readiness` con check de DB.
- Aceptación:
  - Responde no-ok si DB no disponible.

### NH-013 (P1) - Versionado API /v1

- Estado: `done`
- Scope:
  - Namespacing de rutas y compatibilidad con fronts.
- Aceptación:
  - Admin/Portal funcionando con `/v1`.

### NH-014 (P1) - API changelog

- Estado: `done`
- Scope:
  - Documento de cambios de contratos.
- Aceptación:
  - `docs/API_CHANGELOG.md` creado y enlazado en README.

### NH-015 (P1) - Asignación cámara a usuario (subset)

- Estado: `todo`
- Scope:
  - Modelo simple de asignación para `client_user`.
- Aceptación:
  - `client_user` ve solo cámaras asignadas cuando existan asignaciones.

### NH-016 (P1) - Auditoría básica

- Estado: `done`
- Scope:
  - Registrar acciones críticas (crear/editar/eliminar cámara, cambiar suscripción).
- Aceptación:
  - Tabla audit poblada y endpoint mínimo de consulta admin.

### NH-034 (P1) - Scheduler automático de sync health (TDD)

- Estado: `done`
- Scope:
  - Ejecutar `sync-health` en loop automático para cámaras activas.
  - Configuración por env de `enabled`, `interval`, `batch`.
  - Reutilizar la misma lógica de sync manual para evitar divergencia.
- Aceptación:
  - Test de integración verifica actualización automática de lifecycle + snapshot.
  - Errores por cámara no detienen el loop completo.

## P2 - Escalado y producción

### NH-017 (P2) - Contrato ControlPlane->DataPlane

- Estado: `done`
- Scope:
  - Definir interfaces y payloads de integración futura.
- Aceptación:
  - Documento técnico aprobado en `docs/`.

### NH-018 (P2) - Stream-token firmado

- Estado: `done`
- Scope:
  - Reemplazar token mock por token firmado con expiración y claims.
- Aceptación:
  - Validación de firma + expiración.

### NH-019 (P2) - Migración a Postgres (staging/prod)

- Estado: `todo`
- Scope:
  - Configuración datasource y plan de migración.
- Aceptación:
  - API levantando contra Postgres en entorno staging.

### NH-020 (P2) - CI pipeline

- Estado: `todo`
- Scope:
  - typecheck + tests API + e2e smoke.
- Aceptación:
  - Workflow bloquea merge en fallos.

## Nuevas historias (RBAC + Panel + App Cliente)

Fuente: `docs/HISTORIAS_USUARIO_RBAC_TENANTS_PANEL_APP.md`

### NH-035 (P0) - Superadmin global + switch de contexto

- Estado: `todo`
- Scope:
  - `super_admin` con visibilidad total de tenants.
  - Impersonación/switch de contexto con auditoría completa.
- Aceptación:
  - Superadmin puede operar sobre cualquier tenant.
  - Auditoría registra actor real + contexto impersonado.

### NH-036 (P0) - Membresías N:M operadores/customers por tenant

- Estado: `todo`
- Scope:
  - Operadores y customers con asociación N:M a tenants.
  - Enforcement de permisos tenant-scoped en API y UI.
- Aceptación:
  - Un usuario puede pertenecer a múltiples tenants.
  - Acceso fuera de membresía devuelve 403.

### NH-037 (P0) - Gestión de roles y memberships desde panel

- Estado: `todo`
- Scope:
  - UI/Admin para crear/editar usuarios y memberships por rol.
  - Cambio de rol controlado por permisos.
- Aceptación:
  - `tenant_admin` gestiona usuarios solo de su tenant.
  - `super_admin` puede cambiar roles globalmente.

### NH-038 (P0) - UX de errores accionables en cámaras

- Estado: `todo`
- Scope:
  - Mostrar `code`, `message` y `details` de errores backend en panel.
  - Diferenciar errores de autorización/entitlement/validación.
- Aceptación:
  - La UI no muestra solo 404 genérico.
  - Errores incluyen detalle técnico utilizable.

### NH-039 (P1) - Alcance operador global por defecto + zonificación

- Estado: `todo`
- Scope:
  - Política default de visibilidad amplia para operadores.
  - Configuración de zonificación por tenant/sede/cámara.
- Aceptación:
  - Sin zonificación: ve todo lo permitido por membresías.
  - Con zonificación: ve solo subset configurado.

### NH-040 (P1) - App cliente: domicilios y miembros

- Estado: `todo`
- Scope:
  - CRUD de domicilios/casas.
  - Gestión de miembros (familia/empleados) y permisos base.
- Aceptación:
  - Customer puede asociar miembros a domicilios.
  - Permisos mínimos aplican en vistas/notificaciones.

### NH-041 (P1) - App cliente: alta de cámara RTSP y monitor realtime

- Estado: `todo`
- Scope:
  - Alta/edición de cámara RTSP desde app cliente.
  - Validación inicial y estado health visible en monitor.
- Aceptación:
  - Cámara válida queda operativa y visible.
  - Diagnóstico de health legible ante fallas.

### NH-042 (P1) - Notificaciones realtime por reglas de tenant/cámara

- Estado: `todo`
- Scope:
  - Motor de reglas para disparo de notificaciones en vivo.
  - Entrega por canal configurado (in-app/webhook/email).
- Aceptación:
  - Evento detectado genera notificación trazable.
  - Historial de entregas visible para admin.

### NH-043 (P1) - Suscripción cliente + carga de comprobante

- Estado: `todo`
- Scope:
  - Flujo de solicitud de plan en app cliente.
  - Carga de imagen de comprobante con metadata.
- Aceptación:
  - Solicitud queda en `pending_review`.
  - Admin puede revisar y actualizar estado.

## Backlog ejecutable - Migración UI Foundation (Backoffice + Frontend)

Fuente: plan de migración UI (marzo 2026).  
Convención de ejecución: cada item debe salir en PR chica (1 feature principal), con screenshot antes/después y smoke e2e del flujo tocado.

### NH-044 (P0) - Auditoría de pantallas y matriz de prioridad

- Estado: `done`
- Estimación: `1d`
- Dependencias: ninguna.
- Scope:
  - Inventariar rutas/pantallas de `apps/admin` y `apps/portal`.
  - Marcar criticidad (`alta|media|baja`) y frecuencia de uso.
  - Identificar pantallas con solapamiento de campos o densidad insuficiente.
- Aceptación:
  - Documento en `docs/GUI_AUDIT.md` actualizado con severidad por pantalla.
  - Lista ordenada de migración publicada (top 10 pantallas).

### NH-045 (P0) - Contrato de UI base en @app/ui

- Estado: `done`
- Estimación: `2d`
- Dependencias: `NH-044`.
- Scope:
  - Formalizar tokens y componentes base (`WorkspaceShell`, `PageCard`, `FormGrid`, `DataTable`, inputs, buttons, badges).
  - Definir reglas responsive mínimas (`sm/md/lg`) para formularios y tablas.
  - Documentar composición permitida y anti-patrones.
- Aceptación:
  - `docs/CONTRATOS_COMPONENTES.md` incluye sección UI Foundation.
  - `pnpm --filter @app/ui typecheck` en verde.

### NH-046 (P0) - IA/Navegación backoffice por casos de uso

- Estado: `done`
- Estimación: `1d`
- Dependencias: `NH-045`.
- Scope:
  - Estructurar menú admin por dominios: `Operaciones`, `Recursos`, `Identidad`, `Comercial`.
  - Normalizar labels y rutas canónicas.
  - Definir redirects para rutas legacy.
- Aceptación:
  - Menú lateral único sin items duplicados.
  - Rutas principales navegables sin 404.

### NH-047 (P0) - IA/Navegación app cliente por casos de uso

- Estado: `done`
- Estimación: `1d`
- Dependencias: `NH-045`.
- Scope:
  - Estructurar menú portal por dominios: `Operaciones`, `Cuenta`.
  - Homologar nomenclatura de navegación y breadcrumbs.
- Aceptación:
  - Navegación consistente en todas las pantallas del portal.
  - Logout/switch tenant conservan comportamiento actual.

### NH-048 (P0) - Migración vertical Admin Operaciones (control/monitor/realtime/nodes)

- Estado: `done`
- Estimación: `3d`
- Dependencias: `NH-046`.
- Scope:
  - Migrar páginas operativas a layout y componentes `@app/ui`.
  - Corregir densidad visual de tablas y cards de estado.
  - Eliminar clases DaisyUI ad hoc en esas vistas.
- Aceptación:
  - No hay solapamiento de campos en `1280px`, `1024px`, `768px`.
  - `pnpm --filter @app/admin typecheck` en verde.

### NH-049 (P0) - Migración vertical Admin Recursos (cameras/notifications)

- Estado: `done`
- Estimación: `3d`
- Dependencias: `NH-048`.
- Scope:
  - Rehacer listas y detalles con `FormGrid`/`DataTable`.
  - Uniformar estados de error/empty/loading.
  - Conservar comportamiento funcional existente.
- Aceptación:
  - Flujo CRUD cámara operativo sin regresión.
  - Smoke e2e admin relevante en verde.

### NH-050 (P0) - Migración vertical Admin Identidad (tenants/users/memberships)

- Estado: `done`
- Estimación: `3d`
- Dependencias: `NH-049`.
- Scope:
  - Migrar pantallas de identidad/acceso a foundation UI.
  - Estandarizar formularios largos para evitar campos pisados.
  - Mejorar legibilidad de tablas de memberships.
- Aceptación:
  - Formularios de alta/edición legibles en mobile/desktop.
  - No se rompe enforcement RBAC existente.

### NH-051 (P1) - Migración vertical Admin Comercial (plans/subscriptions)

- Estado: `done`
- Estimación: `2d`
- Dependencias: `NH-050`.
- Scope:
  - Migrar pantallas comerciales a componentes base.
  - Homologar badges de estado de suscripción.
- Aceptación:
  - Estados de suscripción visualmente consistentes con resto del panel.
  - `pnpm --filter @app/admin typecheck` en verde.

### NH-052 (P0) - Migración vertical Portal Operaciones (cameras/events/realtime)

- Estado: `done`
- Estimación: `3d`
- Dependencias: `NH-047`.
- Scope:
  - Migrar vistas operativas del usuario final al foundation UI.
  - Normalizar cards, acciones primarias y feedback de error.
- Aceptación:
  - Navegación entre cámaras/eventos/realtime consistente.
  - `pnpm --filter @app/portal typecheck` en verde.

### NH-053 (P1) - Migración vertical Portal Cuenta (tenant/account)

- Estado: `done`
- Estimación: `2d`
- Dependencias: `NH-052`.
- Scope:
  - Ajustar vistas de cuenta/tenant a layout unificado.
  - Unificar copy de acciones de sesión.
- Aceptación:
  - Cambio de tenant y perfil sin regresiones.
  - UI consistente con resto del portal.

### NH-054 (P0) - QA responsive y accesibilidad mínima

- Estado: `done`
- Estimación: `2d`
- Dependencias: `NH-051`, `NH-053`.
- Scope:
  - QA visual en breakpoints `375`, `768`, `1024`, `1280`.
  - Revisar foco visible, contraste y navegación por teclado en componentes base.
- Aceptación:
  - Checklist QA en `docs/GUI_AUDIT.md` completado.
  - No existen bloqueantes de uso por teclado en flujos críticos.

### NH-055 (P0) - Suite de no-regresión UI (smoke)

- Estado: `done`
- Estimación: `2d`
- Dependencias: `NH-054`.
- Scope:
  - Extender smoke e2e admin/portal para cubrir navegación nueva y pantallas críticas migradas.
  - Agregar casos de viewport (desktop + mobile básico).
- Aceptación:
  - `pnpm test:e2e:admin` y `pnpm test:e2e:portal` en verde con nuevo layout.
  - Evidencia de ejecución en `docs/E2E.md`.

## Orden sugerido de ejecución por sprint

### Sprint UI-1 (P0)

- `NH-044`, `NH-045`, `NH-046`, `NH-047`, `NH-048`.

### Sprint UI-2 (P0)

- `NH-049`, `NH-050`, `NH-052`.

### Sprint UI-3 (P0/P1)

- `NH-051`, `NH-053`, `NH-054`, `NH-055`.
