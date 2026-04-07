# NearHome - Descripción técnica del MVP

Fecha de corte: `2026-04-04`

## Alcance del MVP

El MVP valida un flujo end-to-end multi-tenant para monitoreo con cámaras RTSP:

- alta/baja de streams por tenant,
- playback HLS tokenizado por sesión,
- entrega de eventos en tiempo real (WS/SSE),
- pipeline de detección desacoplado con Temporal,
- administración de storage/vaults y retención básica.

No busca todavía latencia hard real-time de nivel productivo final; está orientado a validación técnica/operativa del sistema completo.

## Arquitectura por planos

### 1) Control Plane

Implementación principal: `apps/api`

Responsabilidades:

- API de negocio (`/v1`) para admin/portal.
- Auth + RBAC + aislamiento por tenant (`X-Tenant-Id`).
- Orquestación del ciclo de vida de cámaras.
- Provision/deprovision contra Data Plane.
- Emisión de eventos internos hacia Event Plane.
- Dispatch de jobs de detección (inline o Temporal) y recepción de callbacks.
- Persistencia con Prisma (SQLite local y PostgreSQL en staging).

### 2) Data Plane

Implementación principal: `apps/stream-gateway`

Responsabilidades:

- Contrato HTTP estable para stream lifecycle y playback:
  - `POST /provision`
  - `POST /deprovision`
  - `GET /health/:tenantId/:cameraId`
  - `GET /playback/:tenantId/:cameraId/*`
- Validación de playback tokenizado con HMAC (`STREAM_TOKEN_SECRET`).
- Session tracking (`/sessions`) y sweep de expiración/idle.
- Event clips (`/events/clip`) y reproducción HLS de clips.
- Gestión de storage/vaults, mapa plan->vault y retención.
- Abstracción de motor de media vía adapter (`mock`, `process`, `process-mediamtx`).

### 3) Event Plane

Implementación principal: `apps/event-gateway`

Responsabilidades:

- Distribución realtime por WebSocket y SSE.
- Replay de eventos para clientes.
- Segmentación por tenant.
- Backend de transporte con Redis.
- Endpoint interno de publish protegido por secreto compartido.

### 4) Detection Plane

Implementaciones:

- `apps/detection-worker` (worker Temporal),
- `apps/inference-bridge` (bridge FastAPI),
- `apps/inference-node-yolo` (detección de objetos),
- `apps/inference-node-mediapipe` (pose/actions),
- `apps/audio-detection-runner` (pipeline de detección de audio).

Responsabilidades:

- Orquestar ejecuciones de detección de forma desacoplada del request path principal.
- Seleccionar/encaminar inferencia hacia nodos on-prem.
- Reportar resultados/fallas al Control Plane por callback interno.

## Frontends y paquetes compartidos

- `apps/admin`: backoffice operativo (tenants, usuarios, cámaras, flujos administrativos).
- `apps/portal`: vista cliente/monitor para operación diaria.
- `packages/shared`: contratos/tipos compartidos.
- `packages/api-client`: cliente HTTP con auth + tenant header.
- `packages/ui`: componentes de UI reutilizables.

## Contratos y dependencias críticas

- Contrato Control/Data Plane: `docs/CONTROLPLANE_DATAPLANE_CONTRACT.md`
- Contrato de autenticación de nodos: `docs/NODE_AUTH_CONTRACT.md`
- Contrato de entitlements: `docs/ENTITLEMENTS_CONTRACT.md`

Dependencias operativas clave:

- `STREAM_TOKEN_SECRET` debe coincidir entre API y Stream Gateway.
- `EVENT_PUBLISH_SECRET` protege publish interno al Event Gateway.
- `DETECTION_CALLBACK_SECRET` protege callbacks Worker -> API.

## Observabilidad e infraestructura

- Stack de observabilidad en `infra/observability` (Prometheus + Grafana).
- Composes para entorno local/on-prem en `infra/docker-compose*.yml`.
- Automatización de despliegue y smoke en `ansible/`.

## Estado actual del MVP

El repositorio ya implementa el núcleo funcional para:

- operación multi-tenant,
- playback tokenizado seguro,
- eventing desacoplado,
- detección integrada por workflows,
- políticas básicas de recording/retención/storage.

La evolución posterior está enfocada en robustez de streaming productivo, latencia y escalado operativo.
