# GUI Audit - NearHome Admin/Portal

Fecha: 2026-03-09

## Resumen
- Sí existe panel administrativo (`apps/admin`) y portal operativo (`apps/portal`).
- Cobertura actual previa:
  - Administración de tenants, usuarios, memberships, cámaras, planes, suscripciones.
  - Realtime events (WS/SSE) en admin y portal.
  - Detalle de cámara y lifecycle.
- Gap detectado:
  - No había una vista unificada de estado de deployment/nodos/arquitectura.

## Hallazgos principales
- `apps/admin` estaba orientado a CRUD + realtime, sin `Control Panel` de estado global.
- El backend ya exponía endpoint operativo:
  - `GET /ops/deployment/status`
  - Incluye probes de servicios y estado agregado de nodos de inferencia.
- La información existía, pero no estaba visualizada en una página dedicada.

## Implementación realizada
- Se agregó una nueva sección en Admin: `Control`.
- Ruta nueva: `/control` (ahora home por default).
- Página nueva: `ControlPanelPage` en `apps/admin/src/App.tsx`.
- Funcionalidad incluida:
  - Estado global (`overall ok/degraded`) con refresh manual y auto-refresh cada 15s.
  - Tabla de servicios (target, status HTTP, latencia, error).
  - Registro de nodos (status, tenant, queue, drained, capabilities, models).
  - Vista de jerarquía/arquitectura operativa por plano.

## Resultado esperado de UX
- En un solo lugar se puede ver:
  - Salud de control/data/event/detection plane.
  - Estado de nodos de inferencia y señales de degradación.
  - Mapa conceptual de arquitectura para operación diaria.

## Próximas mejoras sugeridas
- Filtros por `tenantId` y por `node status`.
- Links de drill-down a incidentes/cámaras afectadas.
- Historial temporal de estado (sparklines de salud por servicio/nodo).
- Permisos finos para vista de control según rol.
