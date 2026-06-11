# NearHome POC — Deployment Runbook

## Quick Start (single command)

```bash
# 1. Clone
git clone https://github.com/monotributistar/NearHome.git && cd NearHome

# 2. Install deps
pnpm install

# 3. Start POC stack
docker compose -f infra/docker-compose.poc.yml up -d --build

# 4. Wait for health
curl -f http://localhost:3001/health  # API
curl -f http://localhost:3010/health  # Stream gateway
curl -f http://localhost:8090/health  # Inference bridge

# 5. Seed demo data (optional)
bash scripts/pilot/seed-multi-tenant.sh

# 6. Open Portal
open http://localhost:5174
# Login: client@nearhome.dev / demo1234
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  NearHome POC Stack                   │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   API    │  │ Stream-GW    │  │ Event-GW      │  │
│  │  :3001   │  │    :3010     │  │    :3011      │  │
│  │ Fastify  │  │  Fastify     │  │  Fastify      │  │
│  │ Prisma   │  │  HLS/mock    │  │  WS/SSE       │  │
│  └────┬─────┘  └──────┬───────┘  └──────┬────────┘  │
│       │               │                 │           │
│  ┌────┴───────────────┴─────────────────┴────┐      │
│  │              Redis :6379                   │      │
│  └────────────────────────────────────────────┘      │
│                                                      │
│  ┌──────────────────────────────┐                    │
│  │     Inference Bridge :8090   │                    │
│  │       FastAPI (Python)       │                    │
│  │   /v1/infer/hf/yolo (mock)   │                    │
│  └──────────────────────────────┘                    │
│                                                      │
│  ┌──────────┐  ┌──────────┐                         │
│  │  Portal  │  │  Admin   │                         │
│  │  :5174   │  │  :5173   │  (pnpm dev local)       │
│  └──────────┘  └──────────┘                         │
└──────────────────────────────────────────────────────┘
```

## Services

| Service | Port | Health | Description |
|---------|------|--------|-------------|
| API | 3001 | `/health` | Control plane — tenants, cameras, detection jobs |
| Stream Gateway | 3010 | `/health` | Data plane — RTSP ingest, HLS playback, token scoping |
| Event Gateway | 3011 | `/health` | Event plane — WebSocket/SSE notifications |
| Inference Bridge | 8090 | `/health` | Detection plane — inference routing, HF Spaces proxy |
| Redis | 6379 | — | Pub/sub for event gateway |

## Environment

All secrets are hardcoded for POC (NOT production-ready):

| Variable | POC Value |
|----------|-----------|
| JWT_SECRET | dev-super-secret |
| STREAM_TOKEN_SECRET | dev-stream-token-secret |
| EVENT_PUBLISH_SECRET | dev-event-publish-secret |
| HF_TOKEN | (optional — mock mode without it) |

For production, set these via environment variables or `.env` file.

## Verification

```bash
# Health checks
curl -f http://localhost:3001/health | jq .
curl -f http://localhost:3010/health | jq .
curl -f http://localhost:8090/health | jq .

# Create tenant + camera
TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@nearhome.dev","password":"demo1234"}' | jq -r '.accessToken')

TID=$(curl -s -X POST http://localhost:3001/tenants \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Quick Test"}' | jq -r '.data.id')

CID=$(curl -s -X POST http://localhost:3001/cameras \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: $TID" \
  -H 'content-type: application/json' \
  -d '{"name":"Test Cam","rtspUrl":"rtsp://demo/test","isActive":true}' | jq -r '.data.id')

echo "Tenant=$TID Camera=$CID — OK"

# Detection E2E
bash scripts/pilot/smoke-detection-e2e.sh

# Multi-tenant isolation
bash scripts/pilot/smoke-multi-tenant-rtsp.sh
```

## CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`):
```
PR → lint+typecheck → unit tests → E2E smoke (Playwright) → Docker build
```

## Edge Gateway (Raspberry Pi)

```bash
# On the Raspberry Pi:
NEARHOME_HOST=<tailscale-ip> \
RTSP_CAMERAS="192.168.1.10:554,192.168.1.11:554" \
bash edge-gateway/tailscale/setup.sh install

# Streams become accessible at:
# rtsp://<tailscale-ip>:18554  → Camera 1
# rtsp://<tailscale-ip>:18555  → Camera 2
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `pnpm i --frozen-lockfile` fails | Run `pnpm install --no-frozen-lockfile` first |
| API returns 500 on detection jobs | Check inference-bridge logs: `docker logs nearhome-poc-inference-bridge-1` |
| Stream health "unknown" | Mock engine is normal — set `STREAM_MEDIA_ENGINE=process` for real RTSP |
| Portal blank page | Start Portal dev server: `pnpm dev:portal` |
| Docker build slow | First build downloads base images (~2min). Subsequent builds are cached |
