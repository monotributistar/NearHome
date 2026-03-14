# Test Data Strategy

La base de pruebas de `@app/api` ahora se apoya en dos capas:

1. Seed estable
   - vive en [apps/api/prisma/seed.ts](/Users/monotributistar/SOURCES/NearHome/apps/api/prisma/seed.ts)
   - fixtures compartidas en [apps/api/prisma/seed-fixtures.ts](/Users/monotributistar/SOURCES/NearHome/apps/api/prisma/seed-fixtures.ts)
   - incluye tenants, cámaras, catálogo y nodos conocidos para escenarios de detección, caras y browser e2e de `admin`

2. E2E sobre base conocida
   - usar `pnpm --filter @app/api test:e2e`
   - ese script hace `db:reset` antes de correr los e2e principales

Fixtures seeded actuales:

- `Seed NH-DP20`
  - resolución de jobs desde `pipelineId`
- `Seed NH-DP21 Validation`
  - validación de perfiles contra catálogo y nodo offline
- `Seed NH-DP21 Topology`
  - topología operativa con nodo primario y fallback
- `Seed Faces`
  - cámara estable para clustering e identidad facial
- `Seed Admin Browser`
  - tenant estable para `admin` browser e2e
  - incluye 3 cámaras conocidas:
    - `Seed Admin Ready Cam`
    - `Seed Admin Attention Cam`
    - `Seed Admin Idle Cam`
  - incluye nodo `seed-node-admin-browser-primary` para un escenario runnable y deja otro pipeline sin cobertura para validar estados de atención
- `Seed Portal Browser`
  - tenant estable para `portal` browser e2e
  - incluye cámaras `Seed Portal Ready Cam` y `Seed Portal Entry Cam`
  - incluye eventos seeded, suscripción activa y una `subscription request` pendiente para validar el flujo de cuenta sin crear datos nuevos
- `Seed Portal Scope A` y `Seed Portal Scope B`
  - tenants estables para probar tenant switch e aislamiento visual en `portal`
  - `monitor` pertenece a ambos; `client_user` sólo a `Seed Portal Scope A`

Regla práctica:

- si el test verifica creación de recursos, puede seguir creando datos ad hoc
- si el test verifica comportamiento funcional sobre detección/topología/caras, debe preferir fixtures seeded y limpiar sólo el estado mutable necesario
- si el test browser de `admin` busca smoke o validación de producto, debe preferir `Seed Admin Browser` y evitar crear tenants/cámaras salvo que el caso sea explícitamente CRUD

Comandos recomendados:

- API seeded e2e:
  - `pnpm --filter @app/api test:e2e`
- Browser admin seeded:
  - `pnpm test:e2e:admin:seeded`
- Browser portal seeded:
  - `pnpm test:e2e:portal:seeded`
- Browser completo sobre base conocida:
  - `pnpm test:e2e`
