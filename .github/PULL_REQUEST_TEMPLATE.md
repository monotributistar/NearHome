# Summary

## What changed

- 

## Why

- 

## Scope

- [ ] API
- [ ] Admin
- [ ] Portal
- [ ] UI package (`@app/ui`)
- [ ] Infra/CI

# Verification Checklist

## Multi-tenant and RBAC

- [ ] Endpoints tenant-scoped validate `X-Tenant-Id` correctly.
- [ ] No cross-tenant data exposure (reads/writes blocked outside membership).
- [ ] Role rules verified (`tenant_admin`, `monitor`, `client_user`) for touched flows.
- [ ] Sensitive actions remain restricted and return `403` when applicable.

## Contracts and compatibility

- [ ] API error shape `{ code, message, details? }` preserved.
- [ ] Contract changes documented in `docs/CONTRATOS_COMPONENTES.md`.
- [ ] Breaking changes recorded in `docs/API_CHANGELOG.md`.
- [ ] Legacy routes/redirects still work (if navigation was touched).

## UI/UX quality (if frontend touched)

- [ ] No field overlap or unusable density at `375`, `768`, `1024`, `1280`.
- [ ] Keyboard navigation and visible focus checked in critical flows.
- [ ] Empty/loading/error states are consistent with UI Foundation components.

## Tests and quality gates

- [ ] `pnpm lint`
- [ ] `pnpm --filter @app/api test`
- [ ] `pnpm --filter @app/admin typecheck`
- [ ] `pnpm --filter @app/portal typecheck`
- [ ] `pnpm test:e2e:admin` (when admin flows changed)
- [ ] `pnpm test:e2e:portal` (when portal flows changed)
- [ ] Added/updated tests for the changed behavior.

# Evidence

## Manual checks

- 

## Screenshots or recordings

- 

## Risks and rollback

- Risk:
- Rollback plan:
