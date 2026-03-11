# GUI Audit - NearHome Admin/Portal

Fecha: 2026-03-11  
Estado: `NH-044` completado (auditoría inicial)

## Alcance y método

- Fuentes analizadas:
  - `apps/admin/src/App.tsx`
  - `apps/portal/src/portal-app.tsx`
- Criterios:
  - Frecuencia de uso esperada: `alta`, `media`, `baja`.
  - Complejidad de UI: `alta`, `media`, `baja` (densidad de campos/tablas/acciones).
  - Riesgo visual: `alto`, `medio`, `bajo` (solapamiento, jerarquía, consistencia).
  - Severidad final: `S0` (crítica), `S1` (alta), `S2` (media), `S3` (baja).

Notas:
- Esta auditoría es estática (código/rutas). La validación visual responsive final se ejecuta en `NH-054`.
- Objetivo de esta versión: priorización de migración UI Foundation por impacto operativo.

## Inventario de pantallas - Admin

| Ruta | Pantalla | Perfil principal | Frecuencia | Complejidad UI | Riesgo visual | Severidad | Hallazgo principal |
|---|---|---|---|---|---|---|---|
| `/login` | Login admin | admin/operator | media | baja | bajo | S3 | Formulario simple, riesgo bajo. |
| `/control` | Control panel | operator/admin | alta | media | medio | S2 | Mucha data tabular y estados, falta estandarizar densidad/tipografía. |
| `/monitor` | Monitor cámaras realtime | operator | alta | alta | alto | S0 | Vista crítica con filtros + mosaicos/streams; alta probabilidad de saturación visual. |
| `/cameras` | Cámaras (lista + alta/edición) | admin | alta | alta | alto | S0 | Formulario denso (`md:grid-cols-12`) + tabla + acciones; riesgo de campos pisados. |
| `/cameras/:id` | Detalle cámara + lifecycle + profile | admin/operator | alta | alta | alto | S0 | Pantalla más extensa/mixta (lifecycle, profile, sesiones), requiere re-layout por secciones. |
| `/nodes` | Detection nodes ops | admin/operator | media | alta | alto | S1 | Múltiples tablas/forms/actions en una sola vista; complejidad operativa elevada. |
| `/notifications` | Canales + deliveries | admin/operator | media | alta | alto | S1 | Formulario condicional + doble tabla, riesgo de inconsistencia de spacing. |
| `/users` | Usuarios | admin | media | media | medio | S2 | Create + edición inline en tabla; mejorar legibilidad y acciones por fila. |
| `/memberships` | Memberships | admin | media | media | medio | S2 | Flujo simple pero tabla/form sin jerarquía visual clara. |
| `/tenants` | Tenants | admin/superadmin | media | media | medio | S2 | Edición inline + acciones destructivas; requiere patrones de acción consistentes. |
| `/realtime` | Realtime stream admin | operator | media | media | medio | S2 | Estado de conexión/eventos correcto funcionalmente, pero falta diseño de densidad. |
| `/plans` | Planes | admin/comercial | baja | baja | bajo | S3 | Vista informativa de bajo riesgo. |
| `/subscriptions` | Suscripciones | admin/comercial | media | baja-media | medio | S2 | Flujo de activación simple; falta consistencia visual con estados/botones. |

## Inventario de pantallas - Portal

| Ruta | Pantalla | Perfil principal | Frecuencia | Complejidad UI | Riesgo visual | Severidad | Hallazgo principal |
|---|---|---|---|---|---|---|---|
| `/login` | Login portal | user/operator | media | baja | bajo | S3 | Formulario simple, no bloqueante. |
| `/select-tenant` | Tenant activo | user/operator | media | baja | bajo | S3 | Vista simple, bajo riesgo. |
| `/cameras` | Cámaras portal | user/operator | alta | media | medio | S2 | Grid de cards legacy (daisy) pendiente de estandarizar. |
| `/cameras/:id` | Detalle cámara/stream session | user/operator | alta | alta | alto | S1 | Varias cajas de estado y acciones de sesión; requiere composición más clara. |
| `/events` | Eventos | user/operator | alta | media | medio | S2 | Filtros + tabla; necesita patrón uniforme de filtros/resultados. |
| `/realtime` | Realtime eventos | user/operator | alta | media-alta | alto | S1 | Estado de conexión + feed; alto impacto si la jerarquía visual falla. |
| `/account` | Cuenta | user/operator | baja | baja | bajo | S3 | Bajo riesgo. |

## Top 10 pantallas prioritarias de migración

Ordenado por impacto operativo + severidad + complejidad.

1. `admin:/monitor` - S0
2. `admin:/cameras` - S0
3. `admin:/cameras/:id` - S0
4. `admin:/nodes` - S1
5. `admin:/notifications` - S1
6. `portal:/cameras/:id` - S1
7. `portal:/realtime` - S1
8. `admin:/control` - S2
9. `portal:/events` - S2
10. `portal:/cameras` - S2

## Mapeo a backlog NH-UI

- `NH-048`: cubre prioridades 1, 4, 8.
- `NH-049`: cubre prioridad 2 y parte de 5.
- `NH-050`: cubre `users/memberships/tenants` (severidad S2).
- `NH-052`: cubre prioridades 6, 7, 9, 10.
- `NH-053`: cubre `portal:/select-tenant` y `portal:/account`.
- `NH-054`: validación responsive final sobre todas las anteriores.

## IA canónica Backoffice (NH-046)

Rutas canónicas agrupadas por dominio:

- Operaciones:
  - `/operations/control`
  - `/operations/monitor`
  - `/operations/realtime`
  - `/operations/nodes`
- Recursos:
  - `/resources/cameras`
  - `/resources/cameras/:id`
  - `/resources/notifications`
- Identidad:
  - `/identity/tenants`
  - `/identity/users`
  - `/identity/memberships`
  - `/identity/camera-assignments`
- Comercial:
  - `/commercial/plans`
  - `/commercial/subscriptions`

Redirects legacy activos:

- `/control` -> `/operations/control`
- `/monitor` -> `/operations/monitor`
- `/realtime` -> `/operations/realtime`
- `/nodes` -> `/operations/nodes`
- `/cameras` -> `/resources/cameras`
- `/cameras/:id` -> `/resources/cameras/:id`
- `/notifications` -> `/resources/notifications`
- `/tenants` -> `/identity/tenants`
- `/users` -> `/identity/users`
- `/memberships` -> `/identity/memberships`
- `/camera-assignments` -> `/identity/camera-assignments`
- `/plans` -> `/commercial/plans`
- `/subscriptions` -> `/commercial/subscriptions`

## IA canónica App Cliente (NH-047)

Rutas canónicas agrupadas por dominio:

- Operaciones:
  - `/operations/cameras`
  - `/operations/cameras/:id`
  - `/operations/events`
  - `/operations/realtime`
- Cuenta:
  - `/account/tenant`
  - `/account/profile`

Redirects legacy activos:

- `/cameras` -> `/operations/cameras`
- `/cameras/:id` -> `/operations/cameras/:id`
- `/events` -> `/operations/events`
- `/realtime` -> `/operations/realtime`
- `/select-tenant` -> `/account/tenant`
- `/account` -> `/account/profile`

## Riesgos detectados para ejecución

- Riesgo de regresión funcional en pantallas mixtas (`/cameras/:id`, `/nodes`, `/notifications`).
- Riesgo de inconsistencia temporal entre páginas migradas y legacy durante rollout incremental.
- Riesgo de accesibilidad por controles sin foco/labels normalizados en formularios legacy.

## Checklist de cierre NH-044

- [x] Inventario de rutas/pantallas `admin` + `portal`.
- [x] Severidad por pantalla definida (`S0`..`S3`).
- [x] Lista priorizada top 10 publicada.
- [x] Trazabilidad explícita a backlog `NH-048`..`NH-054`.

## Avance de ejecución (2026-03-11)

- `NH-048` completado:
  - Migradas vistas `admin` de Operaciones: `control`, `monitor`, `realtime`, `nodes`.
  - Estandarización visual sobre `Surface` + `DataTable` + feedback planos.
- `NH-049` completado:
  - Migradas vistas `admin` de Recursos: `cameras`, `notifications`.
  - Formularios/tablas y estados alineados a UI Foundation.
- `NH-050` completado:
  - Migradas vistas `admin` de Identidad: `tenants`, `users`, `memberships`.
  - Tablas y acciones de edición/toggle normalizadas.
- `NH-051` completado:
  - Migradas vistas `admin` de Comercial: `plans`, `subscriptions`.
  - Estados y CTA de activación alineados al sistema base.
- `NH-052` completado:
  - Migradas vistas `portal` de Operaciones: `cameras`, `camera detail`, `events`, `realtime`.
  - Navegación y tablas/event feed alineados a UI Foundation.
- `NH-053` completado:
  - Ajustes de vistas `portal` de Cuenta: `tenant`, `profile`.
- `NH-054` completado:
  - QA responsive automatizada en breakpoints `375`, `768`, `1024`, `1280`.
  - Validación de no-overflow horizontal en rutas críticas admin/portal.
- `NH-055` completado:
  - Smoke no-regresión ejecutado en desktop + mobile básico (`390x844`) para admin y portal.
- Validación ejecutada:
  - `pnpm --filter @app/admin typecheck` en verde.
  - `pnpm --filter @app/portal typecheck` en verde.
  - `pnpm test:e2e:admin` en verde (`9 passed`).
  - `pnpm test:e2e:portal` en verde (`5 passed`).
