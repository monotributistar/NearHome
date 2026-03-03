# NearHome Infra (On-Prem)

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

## Levantar

```bash
docker compose -f infra/docker-compose.yml up -d
```

## Bajar

```bash
docker compose -f infra/docker-compose.yml down
```

## Observabilidad opcional

```bash
docker compose -f infra/docker-compose.yml --profile observability up -d
```

Servicios:

- Prometheus `:9090`
- Grafana `:3005`
