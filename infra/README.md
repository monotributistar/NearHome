# NearHome Infra (Local + On-Prem)

Stack principal para laboratorio/on-prem:

- `api` (`:3001`)
- `stream-gateway` (`:3010`)
- `event-gateway` (`:3011`)
- `inference-bridge` (`:8090`)
- `inference-node-yolo` (`:8091`)
- `inference-node-mediapipe` (`:8092`)
- `detection-worker` (Temporal task queue)
- `temporal` (`:7233`)
- `temporal-ui` (`:8088`)
- `redis` (`:6379`)

## Perfiles

- Base: `infra/docker-compose.yml`
- Local override: `infra/docker-compose.local.yml`
- On-prem override: `infra/docker-compose.onprem.yml`
- Cloudflare Tunnel example config: `infra/cloudflared/config.example.yml`

## Variables de entorno

- Local: copiar `infra/.env.local.example` a `infra/.env.local`
- On-prem: copiar `infra/.env.onprem.example` a `infra/.env.onprem`
- On-prem con vault remoto: usar `infra/.env.onprem.remote`
- En on-prem, el ejemplo activa `ffmpeg-hls-retention` con retención semanal y sweep automático.
- Vaults/local-LAN-VPN: ver `/Users/monotributistar/SOURCES/NearHome/docs/STORAGE_VAULTS.md`

## Levantar / Bajar (recomendado)

```bash
pnpm pilot:stack:up:local
pnpm pilot:stack:down:local

pnpm pilot:stack:up:onprem
pnpm pilot:stack:up:onprem:remote
pnpm pilot:stack:sync-detection:onprem
pnpm pilot:stack:sync-detection:onprem:remote
pnpm pilot:stack:up:onprem:tunnel
pnpm pilot:stack:down:onprem
pnpm pilot:stack:down:onprem:remote
```

Notas operativas:
- `pilot:stack:up:local` ahora corre con `--build` por default para evitar drift entre código y contenedores.
- para desactivar build forzado en local: `NEARHOME_FORCE_BUILD=0 pnpm pilot:stack:up:local`.

Para `onprem:remote`, `stream-gateway` monta `${ONPREM_VAULT_REMOTE_PATH}` del host en `/data/storage-remote`.
Ese path debe existir y ser un mount real (NFS/CIFS/SSHFS/WireGuard+NFS) o un path local de prueba.

## Deployment ejecutable de nodos de detección

El stack local sigue levantando nodos estáticos de laboratorio (`static-detection`).

En `onprem`, si existe `infra/docker-compose.detection.generated.yml`, `stack-up` lo incorpora automáticamente y no levanta los nodos estáticos por default. Ese archivo se puede generar desde control-plane:

```bash
DETECTION_API_URL=http://127.0.0.1:3001 \
DETECTION_ADMIN_PASSWORD=admin \
DETECTION_NODE_IDS=node-yolo-face-01,node-mediapipe-01 \
pnpm pilot:detection:export
```

Variables útiles:
- `DETECTION_AUTH_TOKEN`: evita login por password.
- `DETECTION_ADMIN_EMAIL`: default `admin@nearhome.dev`.
- `DETECTION_ADMIN_PASSWORD`: password para obtener bearer token.
- `DETECTION_NODE_IDS`: csv opcional para exportar sólo ciertos nodos.
- `DETECTION_OUTPUT_COMPOSE`: path alternativo de salida.
- `DETECTION_STACK_SYNC_COMMAND`: comando base que ejecuta `api` cuando recibe `POST /ops/nodes/stack-sync-detection`.
- `DETECTION_STACK_SYNC_TIMEOUT_MS`: timeout por intento para stack sync ejecutado por `api` (default `600000`).
- `DETECTION_STACK_SYNC_MAX_RETRIES`: reintentos por fallo/timeout (default `0`).
- `DETECTION_STACK_SYNC_RETRY_DELAY_MS`: espera entre reintentos (default `2000`).

El archivo generado toma `GET /ops/nodes/:nodeId/deploy-definition` y escribe un override Compose con los servicios deseados del detection plane.

Para operación completa, `pnpm pilot:stack:sync-detection:onprem` hace el flujo en dos fases:
- levanta el stack base sin fallback estático
- espera `api /health`
- exporta `infra/docker-compose.detection.generated.yml`
- reaplica el stack con los nodos generados

Smoke específico:

```bash
pnpm pilot:smoke:detection-sync
pnpm pilot:smoke:stack-sync-api
```

Ese smoke valida que:
- existe `infra/docker-compose.detection.generated.yml`
- el archivo declara `NODE_ID` para nodos generados
- esos mismos nodos aparecen `online` en `inference-bridge`

`pilot:smoke:stack-sync-api` valida el loop operativo `admin/api`:
- login en `api`
- trigger de `POST /ops/nodes/stack-sync-detection` (default `dry-run`)
- polling de `GET /ops/nodes/stack-sync-detection` hasta estado terminal
- validación de `mode/profile/status`

Overrides opcionales para el smoke API:
- `STACK_SYNC_TIMEOUT_MS`
- `STACK_SYNC_MAX_RETRIES`
- `STACK_SYNC_RETRY_DELAY_MS`

## Observabilidad opcional

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml --profile observability up -d
```

Servicios:

- Prometheus `:9090`
- Grafana `:3005`
- Alertmanager `:9093`
- Webhook sink local `:18080` (debug de notificaciones)

Prometheus scrapea:
- `api:3001/metrics`
- `stream-gateway:3010/metrics`
- `inference-bridge:8090/metrics`

Alertas base (Prometheus rules):
- disponibilidad de servicios (`api`, `stream-gateway`, `inference-bridge`)
- stream health scheduler estancado/lento/con fallos
- nodos de inferencia todos offline
- heartbeat de nodos envejecido
- nodos revocados presentes

Alertmanager:
- UI: `http://localhost:9093`
- routing por severidad (`critical`, `warning`, `info`) ya provisionado
- por defecto envía a `alert-webhook` local (echo) para validar payloads
- para webhook real, configurar en `.env`:
  - `ALERTMANAGER_WEBHOOK_DEFAULT_URL`
  - `ALERTMANAGER_WEBHOOK_CRITICAL_URL`
  - `ALERTMANAGER_WEBHOOK_WARNING_URL`
  - `ALERTMANAGER_WEBHOOK_INFO_URL`

Grafana:
- URL: `http://localhost:3005`
- Usuario: `admin`
- Password: `admin`
- Dashboard provisionado: `NearHome / NearHome Stream Health Sync`
- Dashboard provisionado: `NearHome / NearHome Node Lifecycle`

## Smoke rápido por plano

```bash
pnpm pilot:smoke
```

Harness virtual de 2 cámaras para detección E2E:

```bash
pnpm pilot:harness
pnpm pilot:harness:mock
pnpm pilot:harness:lan
```

Para cámaras físicas LAN:

```bash
cp infra/.env.pilot.cameras.example infra/.env.pilot.cameras
pnpm pilot:harness
```

Valida:
- control-plane (`api`)
- data-plane (`stream-gateway` + provision de 2 cámaras virtuales)
- event-plane (`publish` + `replay`)
- detection-plane (`inference-*`, `dispatcher`, `temporal-ui`)
