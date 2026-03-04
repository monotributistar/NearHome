# Pilot Runbook (Local + On-Prem)

Fecha: `2026-03-04`

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

## 6) Riesgos conocidos

- Integraciones externas (Telegram, Cloudflare API) pueden depender de credenciales y conectividad.
- En on-prem, `STREAM_TRANSCODER_DRY_RUN=1` está seteado por defecto para arranque seguro; cambiar a `0` cuando se habilite ingesta real.
