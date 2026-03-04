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

## Levantar / Bajar (recomendado)

```bash
pnpm pilot:stack:up:local
pnpm pilot:stack:down:local

pnpm pilot:stack:up:onprem
pnpm pilot:stack:up:onprem:tunnel
pnpm pilot:stack:down:onprem
```

## Observabilidad opcional

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml --profile observability up -d
```

Servicios:

- Prometheus `:9090`
- Grafana `:3005`

## Smoke rápido por plano

```bash
pnpm pilot:smoke
```

Valida:
- control-plane (`api`)
- data-plane (`stream-gateway` + provision de 2 cámaras virtuales)
- event-plane (`publish` + `replay`)
- detection-plane (`inference-*`, `dispatcher`, `temporal-ui`)
