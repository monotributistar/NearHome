# Plan Accionable Local - Deployment y Validación End-to-End (4 Tenants)

Fecha de actualización: `2026-04-05`
Objetivo: validar un escenario tipo productivo en local con 4 tenants, flujo GUI operativo y onboarding de red (VPN + router + cámaras).

## 1) Resultado esperado (Definition of Success)

Al finalizar el plan:

- stack local NearHome operativo.
- existen 4 tenants activos.
- cada tenant tiene un usuario representante (`tenant_admin`) que:
  - crea usuarios desde GUI (`apps/admin`),
  - da de alta cámaras desde GUI,
  - asocia cámara a VPN/espacio de red (cuando la feature NH-NET esté activa).
- existe trazabilidad técnica para instalador:
  - parámetros de VPN por tenant,
  - parámetros de router/dispositivo por cámara,
  - checklist de verificación.

## 2) Alcance por etapas

## Etapa A - Preparación de entorno local

Objetivo:

- entorno reproducible para pruebas multi-tenant.

Pasos:

1. Bootstrap:
   - `pnpm bootstrap`
2. Levantar stack:
   - `pnpm pilot:stack:up:local`
3. Smoke base:
   - `pnpm pilot:smoke`
4. Smoke product-like:
   - `pnpm pilot:smoke:prod-local`

Criterio de salida:

- todos los comandos anteriores en verde.

## Etapa B - Seed/control de 4 tenants

Objetivo:

- disponer de 4 tenants de prueba para validación funcional.

Datos objetivo:

- `TENANT_A`, `TENANT_B`, `TENANT_C`, `TENANT_D`
- 1 representante `tenant_admin` por tenant:
  - `admin.a@nearhome.dev`
  - `admin.b@nearhome.dev`
  - `admin.c@nearhome.dev`
  - `admin.d@nearhome.dev`

Implementación sugerida:

1. Crear tenants con superadmin (API/GUI admin).
2. Crear usuario representante por tenant.
3. Asignar membresía `tenant_admin` correcta por tenant.
4. Verificar login de cada representante.

Pruebas obligatorias:

- cada representante ve solo su tenant.
- no puede editar tenants/cámaras fuera de su scope.

## Etapa C - Validación GUI por representante de tenant

Objetivo:

- comprobar operación real desde frontend (`apps/admin`/`apps/portal`).

Flujo mínimo por cada tenant (A-D):

1. Login en `admin`.
2. Crear 2 usuarios:
   - `monitor`
   - `client_user`
3. Alta de 2 cámaras desde GUI:
   - `CAM_<TENANT>_01`
   - `CAM_<TENANT>_02`
4. Validar lifecycle de cámara (`draft/provisioning/ready`).
5. Emitir stream token y abrir playback desde portal.

Pruebas obligatorias:

- RBAC UI:
  - `tenant_admin`: crea/edita usuarios y cámaras.
  - `monitor`: no crea usuarios.
- aislamiento:
  - no visualiza datos de otro tenant.

## Etapa D - VPN por tenant + asociación de cámara (feature NH-NET)

Objetivo:

- activar onboarding de conectividad por tenant.

Dependencia:

- implementación de `docs/VPN_NETWORK_LIFECYCLE_CONTRACT.md` + `docs/HISTORIAS_TECNICAS_VPN_TDD.md`.

Flujo objetivo por tenant:

1. Crear VPN tenant-scoped.
2. Definir `networkSpace` (`camera_lan` CIDR).
3. Validar plan de red (sin overlap cross-tenant).
4. Provisionar VPN (ideal: `dryRun` y luego `apply`).
5. Asociar cada cámara a:
   - `vpnId`
   - `networkSpaceId`
6. Validar stream-token condicionado por estado VPN.

Pruebas obligatorias:

- overlap CIDR entre tenants devuelve error de dominio.
- cámara con VPN `active` permite token.
- cámara con VPN `failed/revoked` bloquea token.

## Etapa E - Configuración de router accesible para instalador

Objetivo:

- entregar parámetros claros por dispositivo y tenant.

Resultado esperado:

- vista/export en GUI/API con ficha técnica por cámara:
  - red local de cámara,
  - ruta/VPN asignada,
  - endpoint de destino,
  - parámetros de router requeridos.

Formato recomendado de ficha por dispositivo:

- Identidad:
  - `tenantId`
  - `siteId`
  - `cameraId`
  - `deviceLabel`
- VPN:
  - `vpnProvider`
  - `vpnPeerId`
  - `vpnLocalCidr`
  - `vpnRemoteCidr`
  - `tunnelEndpoint`
  - `keepaliveSeconds`
- Router:
  - `lanInterface`
  - `lanGateway`
  - `staticRouteDestination`
  - `staticRouteNextHop`
  - `natPolicy` (`enabled/disabled`)
  - `firewallAllowlist` (IPs/ports)
- Cámara:
  - `cameraIp`
  - `rtspPort`
  - `rtspPath`
  - `transport` (`tcp/udp`)
  - `credentialsRef` (nunca credencial en texto plano)
- Verificación:
  - `pingResult`
  - `rtspProbeResult`
  - `vpnHandshakeAt`
  - `validatedBy`
  - `validatedAt`

## 3) Matriz de pruebas de deployment (4 tenants)

Matriz mínima:

1. Infra/servicios:
   - `api`, `stream-gateway`, `event-gateway`, `inference-bridge`, `detection-dispatcher`, `temporal-ui`.
2. Multi-tenant:
   - 4 tenants activos con representante válido.
3. GUI usuarios:
   - creación y edición de usuarios por `tenant_admin` en cada tenant.
4. GUI cámaras:
   - alta y edición de cámaras por tenant.
5. Streaming:
   - stream-token + playback por tenant sin fugas cross-tenant.
6. Detección/eventos:
   - job de detección y replay SSE por tenant.
7. VPN/red (cuando NH-NET esté activo):
   - create/validate/provision por tenant.
   - bloqueo de overlap CIDR.
   - asociación cámara->VPN.
8. Router/install:
   - ficha exportable por cámara/dispositivo.

## 4) Suite recomendada de ejecución

Orden:

1. `pnpm pilot:stack:up:local`
2. `pnpm pilot:smoke`
3. `pnpm pilot:smoke:prod-local`
4. `pnpm --filter @app/api test`
5. `pnpm --filter @app/stream-gateway test`
6. `pnpm --filter @app/event-gateway test`
7. `pnpm test:e2e:admin`
8. `pnpm test:e2e:portal`
9. (cuando exista) `pnpm pilot:smoke:vpn`

## 5) Plan TDD de implementación real (resumen)

Orden de entrega técnica:

1. NH-NET-01/02: modelo + validación CIDR.
2. NH-NET-03/04/05: lifecycle + endpoints VPN.
3. NH-NET-06/07: asociación cámara + gate de token.
4. NH-NET-08/09: peers/rutas/rotación.
5. NH-NET-10/11: observabilidad + smoke VPN 4 tenants.

Regla TDD:

- siempre escribir primero tests rojos de la etapa y luego implementar mínimo para verde.

## 6) Checklist Go/No-Go

Go:

- 4 tenants funcionales y aislados.
- representantes crean usuarios y cámaras por GUI sin fallback manual.
- deployment local estable (smokes green).
- evidencia de pruebas guardada (logs/reportes).
- configuración router por dispositivo disponible para instalador.

No-Go:

- fallas de aislamiento tenant.
- cámara operativa sin asociación de red obligatoria (cuando NH-NET esté activo).
- ausencia de parámetros instalables por dispositivo.

## 7) Entregables operativos

- runbook de ejecución local actualizado.
- matriz de resultados por tenant (`A/B/C/D`).
- reporte final de validación:
  - servicios,
  - GUI,
  - cámaras,
  - VPN/red,
  - incidencias abiertas.
