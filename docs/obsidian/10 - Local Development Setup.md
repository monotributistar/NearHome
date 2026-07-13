---
tags: [nearhome, setup, local]
status: active
---

# Local Development Setup

## 1. Prerrequisitos

- macOS o Linux.
- Node.js compatible con el lockfile y PNPM.
- Docker Desktop o Docker Engine con Compose v2.
- Python 3 para tests del discovery agent.
- FFmpeg para simulacion y diagnostico de streams.

Opcionales por capa:

- NVIDIA driver y Container Toolkit: solo Linux box GPU.
- WireGuard: edge/hub o laboratorio Linux.
- Tailscale/Headscale: control remoto.
- Balena CLI: solo evaluacion posterior.

## 2. Bootstrap del monorepo

Desde la raiz:

```bash
pnpm install
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/admin/.env.example apps/admin/.env
cp apps/portal/.env.example apps/portal/.env
```

Los `.env` reales no se versionan. Ver [[11 - Credentials and Environment Variables]].

## 3. Base de datos y API

```bash
pnpm --filter @app/api db:reset
pnpm dev:api
```

Validar:

```bash
curl -fsS http://localhost:3001/health
```

El reset elimina la SQLite local, recrea el schema y carga fixtures demo.

## 4. Stack base local

Opcion modular:

```bash
pnpm dev:stream
pnpm dev:event
pnpm dev:admin
pnpm dev:portal
```

Opcion Docker:

```bash
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml up -d --build
```

## 5. PoC integrada

```bash
docker compose -f infra/docker-compose.poc.yml config
docker compose -f infra/docker-compose.poc.yml up -d --build
```

Esta composicion incluye componentes experimentales. No representa todavia la
ruta productiva canonica del detector.

## 6. Validacion minima

```bash
pnpm --filter @app/api typecheck
JWT_SECRET=local-test CAMERA_CREDENTIALS_KEY=local-test \
  pnpm --filter @app/api test:edge
python3 -m pytest edge-gateway/discovery-agent/tests -q
pnpm pilot:smoke
```

## 7. Apagado

```bash
docker compose -f infra/docker-compose.poc.yml down
docker compose -f infra/docker-compose.yml down
```

No usar `down -v` salvo que se quiera eliminar datos locales deliberadamente.
