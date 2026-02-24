# NearHome POC Monorepo

Monorepo PNPM + Turborepo con:

- `apps/api`: Fastify + Prisma (SQLite) control-plane POC
- `apps/admin`: Refine headless + React Router + simple-rest
- `apps/portal`: cliente/monitor con React Router
- `packages/shared`: contratos Zod + tipos compartidos
- `packages/api-client`: fetch client con auth + tenant header
- `packages/ui`: componentes UI (daisyUI + primitive modal estilo shadcn)

## Documentos de planificación

- Plan general por etapas: `/Users/monotributistar/SOURCES/NearHome/docs/PLAN_GENERAL.md`
- Contratos por componente/interfaz: `/Users/monotributistar/SOURCES/NearHome/docs/CONTRATOS_COMPONENTES.md`
- Backlog ejecutable (issues locales): `/Users/monotributistar/SOURCES/NearHome/docs/BACKLOG.md`
- Sprint actual: `/Users/monotributistar/SOURCES/NearHome/docs/SPRINT_01.md`
- Orden de ejecución recomendado: `/Users/monotributistar/SOURCES/NearHome/docs/EXECUTION_ORDER.md`
- Progreso + cambios + problemas por etapa: `/Users/monotributistar/SOURCES/NearHome/docs/PROGRESO.md`

## Requisitos

- Node.js 20+
- pnpm 9+

## Setup

1. Bootstrap automático (recomendado):

```bash
pnpm bootstrap
```

2. Setup manual:

```bash
pnpm i
```

3. Variables de entorno:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/admin/.env.example apps/admin/.env
cp apps/portal/.env.example apps/portal/.env
```

4. Reset DB + seed:

```bash
pnpm db:reset
```

5. Levantar todo:

```bash
pnpm dev
```

## URLs dev

- API: `http://localhost:3001`
- Admin: `http://localhost:5173`
- Portal: `http://localhost:5174`

## Usuarios seed (password: `demo1234`)

- `admin@nearhome.dev` (`tenant_admin` en tenant A y B)
- `monitor@nearhome.dev` (`monitor` en tenant A)
- `client@nearhome.dev` (`client_user` en tenant A)

## Comandos DX

- `pnpm bootstrap`
- `pnpm run setup`
- `pnpm dev`
- `pnpm db:reset`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test:e2e`
- `pnpm test:e2e:admin`
- `pnpm test:e2e:portal`

## Estado

POC funcional orientado a control-plane. Data-plane real (ingesta RTSP/detección/streaming productivo) queda para la siguiente etapa.
