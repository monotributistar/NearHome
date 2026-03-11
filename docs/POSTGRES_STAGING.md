# Staging con PostgreSQL (NH-019)

Objetivo: levantar `apps/api` contra PostgreSQL en entorno staging, manteniendo SQLite para desarrollo local.

## Archivos involucrados

- Override compose: `infra/docker-compose.postgres-staging.yml`
- Script de schema Prisma Postgres: `apps/api/prisma/scripts/render-postgres-schema.sh`
- Scripts API:
  - `pnpm --filter @app/api prisma:generate:postgres`
  - `pnpm --filter @app/api db:push:postgres`

## Flujo recomendado

1. Levantar stack staging con override Postgres:

```bash
pnpm staging:stack:up:postgres
```

2. Verificar salud de API:

```bash
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:3001/readiness
```

3. Bajar stack:

```bash
pnpm staging:stack:down:postgres
```

## Notas

- El flujo local (`pnpm db:reset`, `pnpm dev`) sigue usando SQLite.
- Para staging, el override:
  - cambia `DATABASE_URL` a Postgres,
  - genera cliente Prisma con provider Postgres,
  - aplica `prisma db push`,
  - build + start de API.
