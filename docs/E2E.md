# E2E Smoke (NH-006 / NH-007)

## Suites

- Admin smoke: `e2e/tests/admin.smoke.spec.ts`
- Admin users: `e2e/tests/admin.users.spec.ts`
- Admin RBAC: `e2e/tests/admin.rbac.spec.ts`
- Admin cameras profile: `e2e/tests/admin.cameras-profile.spec.ts`
- Admin cameras lifecycle: `e2e/tests/admin.cameras-lifecycle.spec.ts`
- Admin tenants: `e2e/tests/admin.tenants.spec.ts`
- Portal smoke: `e2e/tests/portal.smoke.spec.ts`

## Cobertura

### NH-006 Admin

- Login
- Navegación a cámaras
- Crear cámara
- Editar cámara
- Eliminar cámara

### NH-007 Portal

- Login
- Listado de cámaras
- Detalle de cámara
- Obtener stream token mock
- Activar sesión de stream (`issued -> active`)
- Cerrar sesión de stream (`active -> ended`)
- Listado de eventos

### NH-022 Admin Users

- Login admin
- Crear usuario en tenant activo
- Editar nombre de usuario
- Cambiar rol (`client_user` -> `monitor`)

### NH-023/NH-024 Admin RBAC

- Login como `monitor` y validar UI read-only en cámaras/usuarios/subscriptions
- Login como `client_user` y validar que no puede crear/editar/eliminar cámaras
- Validar que acciones de cambio de plan no están disponibles sin permiso de edición

### NH-026 Admin Camera Profile

- Login admin
- Crear cámara con `description`
- Abrir detalle de cámara
- Configurar perfil interno (`proxyPath`, recording, storage keys, detector keys, detector flags)
- Guardar y validar persistencia
- Forzar config incompleta y validar fallback visual (`profile-fallback-alert`)

### NH-027 Admin Camera Lifecycle

- Login admin
- Crear cámara inactiva (estado inicial `draft`)
- Abrir detalle de cámara
- Ejecutar acción `Validate`
- Verificar transición de estado `draft -> ready`

### NH-029 Admin Tenants

- Login admin
- Crear tenant
- Editar tenant
- Eliminar tenant

## Comandos

1. Reset datos:

```bash
pnpm db:reset
```

2. Instalar browser de Playwright (solo primera vez):

```bash
npx playwright install chromium
```

3. Ejecutar E2E:

```bash
pnpm test:e2e
# o suites individuales
pnpm test:e2e:admin
pnpm test:e2e:portal
```

## Notas operativas / incidentes

- Fecha: `2026-02-24`
- Al correr `pnpm test:e2e:admin` y `pnpm test:e2e:portal` en paralelo, Playwright puede fallar con `config.webServer was not able to start` por colisión de arranque.
- Mitigación recomendada: ejecutar suites E2E en secuencia para validación estable de CI/local.
