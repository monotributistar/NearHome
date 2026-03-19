# Pilot Runbook (Local + On-Prem)

Fecha: `2026-03-16`

## 1) Objetivo

Levantar un entorno mínimo de piloto para validar los 4 planos:

- control-plane
- data-plane
- event-plane
- detection-plane

## 2) Preparación

1. Instalar dependencias y bootstrap:

```bash
pnpm bootstrap
```

2. Crear env local:

```bash
cp infra/.env.local.example infra/.env.local
```

3. Crear env on-prem:

```bash
cp infra/.env.onprem.example infra/.env.onprem
```

Editar al menos:
- `ONPREM_ADMIN_ORIGIN`
- `ONPREM_PORTAL_ORIGIN`
- `CLOUDFLARE_TUNNEL_TOKEN` (si usás túnel)

## 3) Arranque local

```bash
pnpm pilot:stack:up:local
```

Smoke de planos:

```bash
pnpm pilot:smoke
```

Parada:

```bash
pnpm pilot:stack:down:local
```

## 4) Arranque on-prem

Sin túnel:

```bash
pnpm pilot:stack:up:onprem
```

Con túnel Cloudflare:

```bash
pnpm pilot:stack:up:onprem:tunnel
```

Smoke:

```bash
pnpm pilot:smoke
```

Parada:

```bash
pnpm pilot:stack:down:onprem
```

## 5) Checklist de aceptación rápida (Go/No-Go)

- `api` responde `/health`.
- `stream-gateway` responde `/health` y provisiona 2 cámaras virtuales.
- `event-gateway` acepta publish interno y responde replay SSE.
- `inference-bridge`, `inference-node-yolo`, `inference-node-mediapipe`, `detection-dispatcher` responden `/health`.
- `temporal-ui` responde.

## 6) Harness de 2 cámaras (PILOT-B1)

Para cámaras físicas en LAN (2 cámaras):

```bash
cp infra/.env.pilot.cameras.example infra/.env.pilot.cameras
```

Editar `infra/.env.pilot.cameras` con tus RTSP reales (`PILOT_CAM1_RTSP`, `PILOT_CAM2_RTSP`).

Preparar (login + tenant + registro nodos + creación de 2 cámaras virtuales):

```bash
pnpm pilot:harness:prepare
```

Bootstrap explícito de nodos (si no usás harness o querés validar manualmente):

```bash
export NODE_AUTH_ADMIN_SECRET="${NODE_AUTH_ADMIN_SECRET:-dev-node-auth-admin-secret}"

YOLO_ENROLL="$(curl -sS -X POST http://localhost:8090/internal/nodes/enrollment-tokens \
  -H "x-node-auth-admin-secret: $NODE_AUTH_ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"nodeId":"node-yolo-local","tenantScope":"*"}' | jq -r '.data.enrollmentToken')"
YOLO_TOKEN="$(curl -sS -X POST http://localhost:8090/v1/nodes/enroll \
  -H 'content-type: application/json' \
  -d "{\"nodeId\":\"node-yolo-local\",\"enrollmentToken\":\"$YOLO_ENROLL\"}" | jq -r '.data.nodeAccessToken')"

MEDIAPIPE_ENROLL="$(curl -sS -X POST http://localhost:8090/internal/nodes/enrollment-tokens \
  -H "x-node-auth-admin-secret: $NODE_AUTH_ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"nodeId":"node-mediapipe-local","tenantScope":"*"}' | jq -r '.data.enrollmentToken')"
MEDIAPIPE_TOKEN="$(curl -sS -X POST http://localhost:8090/v1/nodes/enroll \
  -H 'content-type: application/json' \
  -d "{\"nodeId\":\"node-mediapipe-local\",\"enrollmentToken\":\"$MEDIAPIPE_ENROLL\"}" | jq -r '.data.nodeAccessToken')"

curl -sS -X POST http://localhost:8090/v1/nodes/register \
  -H "authorization: Bearer $YOLO_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "nodeId":"node-yolo-local",
    "runtime":"python",
    "transport":"http",
    "endpoint":"http://localhost:8091",
    "status":"online",
    "resources":{"cpu":2,"gpu":0,"vramMb":0},
    "capabilities":[{"capabilityId":"cap-yolo","taskTypes":["object_detection"],"models":["yolo26n@1.0.0"]}],
    "models":["yolo26n@1.0.0"],
    "maxConcurrent":2,
    "queueDepth":0,
    "isDrained":false
  }'

curl -sS -X POST http://localhost:8090/v1/nodes/register \
  -H "authorization: Bearer $MEDIAPIPE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "nodeId":"node-mediapipe-local",
    "runtime":"python",
    "transport":"http",
    "endpoint":"http://localhost:8092",
    "status":"online",
    "resources":{"cpu":2,"gpu":0,"vramMb":0},
    "capabilities":[{"capabilityId":"cap-mediapipe","taskTypes":["pose_estimation","action_recognition"],"models":["mediapipe_pose@0.10.0"]}],
    "models":["mediapipe_pose@0.10.0"],
    "maxConcurrent":2,
    "queueDepth":0,
    "isDrained":false
  }'

curl -sS http://localhost:8090/v1/nodes | jq
```

Heartbeat manual (opcional, mismo payload que `register`):

```bash
curl -sS -X POST http://localhost:8090/v1/nodes/heartbeat \
  -H "authorization: Bearer $YOLO_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"nodeId":"node-yolo-local","status":"online","queueDepth":0}'
```

Ejecutar detección E2E sobre ambas cámaras:

```bash
pnpm pilot:harness:run
```

Atajo de punta a punta:

```bash
pnpm pilot:harness
```

Switch rápido por entorno de cámaras:

```bash
pnpm pilot:harness:mock
pnpm pilot:harness:lan
```

Limpieza:

```bash
pnpm pilot:harness:cleanup
```

Variables útiles:
- `PILOT_EMAIL`, `PILOT_PASSWORD`
- `PILOT_TENANT_ID`
- `PILOT_CAM1_NAME`, `PILOT_CAM2_NAME`
- `PILOT_CAM1_RTSP`, `PILOT_CAM2_RTSP`
- `PILOT_ENV_FILE` (default: `infra/.env.pilot.cameras`)
- `BRIDGE_URL`
- `YOLO_URL`, `MEDIAPIPE_URL` (para registro de nodos)
- `NODE_AUTH_ADMIN_SECRET` (bootstrap de enrollment token en bridge)
- `PILOT_JOB_TIMEOUT_S`, `PILOT_JOB_POLL_S`

## 7) Riesgos conocidos

- Integraciones externas (Telegram, Cloudflare API) pueden depender de credenciales y conectividad.
- En on-prem, el perfil ejemplo usa `STREAM_TRANSCODER_PRESET=ffmpeg-hls-retention` y `STREAM_TRANSCODER_DRY_RUN=0`; validar capacidad de disco y ajustar bitrate/segmentación antes de escalar cámaras.

## 8) Observabilidad mínima por plano

- `stream-gateway`: `GET /health`, `GET /metrics`
- `api`: `GET /health`, `GET /readiness`
- `event-gateway`: `GET /health`
- `inference-bridge`: `GET /health`, `GET /v1/nodes`

## 9) Runbook operativo stack-sync (admin/api)

Objetivo: ejecutar el loop de sincronización de nodos de detección desde `control-plane`, con validación previa y rollback simple.

### 9.1 Pre-check

1. Confirmar stack arriba (`onprem` o `onprem-remote`):

```bash
pnpm pilot:stack:up:onprem
# o
pnpm pilot:stack:up:onprem:remote
```

2. Confirmar salud base:

```bash
pnpm pilot:smoke
```

3. Confirmar credenciales para admin/api:

```bash
export DETECTION_DEPLOY_ADMIN_PASSWORD='<admin-password>'
```

### 9.2 Dry-run obligatorio

```bash
STACK_SYNC_MODE=onprem \
STACK_SYNC_DRY_RUN=1 \
pnpm pilot:smoke:stack-sync-api
```

Para vault remoto:

```bash
STACK_SYNC_MODE=onprem-remote \
STACK_SYNC_DRY_RUN=1 \
pnpm pilot:smoke:stack-sync-api
```

### 9.3 Ejecución real

Desde admin UI (`/ops`) o por API:

```bash
STACK_SYNC_MODE=onprem \
STACK_SYNC_DRY_RUN=0 \
pnpm pilot:smoke:stack-sync-api
```

Opcional con perfil:

```bash
STACK_SYNC_MODE=onprem \
STACK_SYNC_PROFILE=tunnel \
STACK_SYNC_DRY_RUN=0 \
pnpm pilot:smoke:stack-sync-api
```

### 9.4 Validación post-run

```bash
pnpm pilot:smoke
pnpm pilot:smoke:detection-sync
```

Esperado:
- servicios principales `Up`
- `infra/docker-compose.detection.generated.yml` presente
- nodos generados reportando `online` en `inference-bridge`

### 9.5 Rollback operativo

Si falla la corrida real:

1. Volver al modo/perfil estable anterior.
2. Reejecutar sync en `dry-run` para validar:

```bash
STACK_SYNC_MODE=onprem \
STACK_SYNC_DRY_RUN=1 \
pnpm pilot:smoke:stack-sync-api
```

3. Reaplicar stack estable:

```bash
pnpm pilot:stack:sync-detection:onprem
# o
pnpm pilot:stack:sync-detection:onprem:remote
```

4. Confirmar recuperación:

```bash
pnpm pilot:smoke
pnpm pilot:smoke:detection-sync
pnpm pilot:smoke:stack-sync-api
```

### 9.6 Matriz rápida de fallos (stack sync)

- `STACK_SYNC_ALREADY_RUNNING` (HTTP 409): ya hay una corrida activa; esperar estado terminal y reintentar.
- `failed + Stack sync exited with code N`: fallo del comando base; revisar `logTail` y validar comando/credenciales.
- `failed + Stack sync timed out`: subir `DETECTION_STACK_SYNC_TIMEOUT_MS` o corregir bloqueos en script remoto.
- Reintentos: `DETECTION_STACK_SYNC_MAX_RETRIES` y `DETECTION_STACK_SYNC_RETRY_DELAY_MS` controlan recuperación automática.
- `inference-node-yolo`: `GET /health`
- `inference-node-mediapipe`: `GET /health`
- `detection-dispatcher`: `GET /health`
