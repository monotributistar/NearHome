# Historias Técnicas y Plan TDD (VPN + Espacios de Red por Tenant)

Base contractual: `docs/VPN_NETWORK_LIFECYCLE_CONTRACT.md`

Fecha de actualización: `2026-04-05`

## 1) Objetivo

Definir un plan ejecutable por etapas para implementar:

- VPN tenant-scoped,
- espacios de red por tenant (CIDR/rutas),
- asociación cámara -> VPN,
- ciclo de vida y operación segura.

Incluye estrategia TDD real por fase para validar backend, integración y operación.

## 2) Epics y orden recomendado

1. Epic A: Modelo de red y validación de CIDR.
2. Epic B: Ciclo de vida VPN (estado/transiciones/provision).
3. Epic C: Asociación de cámaras a VPN y reglas operativas.
4. Epic D: Operación de peers/rutas y rotación de credenciales.
5. Epic E: Observabilidad, auditoría, smoke y hardening.

## 3) Historias técnicas priorizadas

## Epic A - Modelo y validación de red

### NH-NET-01 - Modelo persistente de VPN por tenant

Como plataforma de control-plane
quiero persistir `TenantVpn`, `TenantNetworkSpace`, `TenantVpnRoutePolicy`, `TenantVpnPeer`
para gestionar conectividad por tenant con aislamiento fuerte.

Criterios de aceptación:

- migraciones Prisma creadas y aplicables.
- relaciones `tenantId` obligatorias.
- constraints para evitar duplicados de `vpn.name` por tenant.

Tests TDD (primero):

- integración DB: creación/lectura/update de entidades.
- test de constraint (`tenantId + vpnName` único).

### NH-NET-02 - Validador de espacios de red (CIDR + overlap)

Como control-plane
quiero validar CIDRs y detectar superposición entre tenants
para prevenir conflictos de ruteo.

Criterios de aceptación:

- rechaza CIDR inválido.
- rechaza overlap contra tenant distinto.
- rechaza `/0` y rangos reservados NearHome.
- permite CIDR no conflictivo.

Tests TDD (primero):

- unit: parser/normalización CIDR.
- unit: matriz de overlap/no-overlap.
- integración API con errores tipificados (`VPN_CIDR_OVERLAP`, `VPN_NETWORK_SPACE_INVALID`).

## Epic B - Lifecycle de VPN

### NH-NET-03 - Estado y transiciones de ciclo de vida VPN

Como operador de red
quiero que la VPN tenga estados y transiciones explícitas
para operar con control y rollback.

Criterios de aceptación:

- estados: `draft|validating|provisioning|active|degraded|revoking|revoked|failed`.
- transiciones inválidas devuelven `VPN_STATUS_TRANSITION_INVALID`.
- historial de lifecycle persistido.

Tests TDD (primero):

- unit: state machine pura (tabla de transición).
- integración API: transición válida e inválida.

### NH-NET-04 - Endpoints base de VPN (CRUD + validate + health)

Como `tenant_admin/super_admin`
quiero gestionar VPN por API
para operar onboarding de red.

Criterios de aceptación:

- `POST /v1/network/tenants/:tenantId/vpns`
- `POST /v1/network/tenants/:tenantId/vpns/:vpnId/validate`
- `GET /v1/network/tenants/:tenantId/vpns/:vpnId`
- `GET /v1/network/tenants/:tenantId/vpns/:vpnId/health`
- RBAC y tenant-scope aplicados.

Tests TDD (primero):

- integración API multi-tenant isolation.
- integración RBAC (`tenant_admin` permitido, `monitor` restringido en mutaciones).

### NH-NET-05 - Provisioner abstracto (dry-run + apply)

Como plataforma
quiero un adapter de provision VPN (`dryRun/apply`)
para desacoplar proveedor de red.

Criterios de aceptación:

- interfaz `VpnProvisioner` inyectable.
- modo `dryRun` produce plan sin cambios.
- modo `apply` actualiza estado a `active|degraded|failed`.

Tests TDD (primero):

- unit con fake provisioner.
- integración de endpoint `provision` usando inyección.

## Epic C - Cámaras sobre VPN

### NH-NET-06 - Asociación cámara -> vpnId/networkSpaceId

Como `tenant_admin`
quiero asociar cada cámara a una VPN y espacio de red
para enrutar RTSP por túnel correcto.

Criterios de aceptación:

- campos nuevos en cámara/perfil.
- validación: `vpnId` y `networkSpaceId` del mismo tenant.
- list/detail de cámara refleja asociación.

Tests TDD (primero):

- integración API de create/update cámara con asociación válida/invalid.
- regresión de endpoints existentes de cámaras.

### NH-NET-07 - Gate de stream-token según estado VPN

Como control-plane
quiero bloquear emisión de stream token cuando la VPN no está operativa
para evitar sesiones inválidas.

Criterios de aceptación:

- `active`: permite.
- `degraded`: permite con warning/auditoría.
- `failed|revoking|revoked`: bloquea con error de dominio.

Tests TDD (primero):

- integración en `POST /cameras/:id/stream-token`.
- casos de estado y código de error.

## Epic D - Operación de red y credenciales

### NH-NET-08 - Gestión de peers y route policies por tenant

Como operador NearHome
quiero administrar peers y políticas de ruta por VPN
para controlar alcance y seguridad de conectividad.

Criterios de aceptación:

- endpoints de peers/routes con tenant-scope.
- deny-all por defecto, allowlist explícita.
- no permite rutas a CIDRs de otro tenant.

Tests TDD (primero):

- unit de validación de políticas.
- integración API de CRUD peer/route.

### NH-NET-09 - Rotación de credenciales VPN

Como seguridad de plataforma
quiero rotar credenciales con ventana de gracia
para reducir riesgo operacional.

Criterios de aceptación:

- endpoint `rotate-credentials`.
- estado transicional y resultado auditado.
- no se persisten secretos en texto plano.

Tests TDD (primero):

- integración endpoint + auditoría.
- unit de policy de rotación y grace period.

## Epic E - Observabilidad y hardening

### NH-NET-10 - Métricas y auditoría de VPN

Como operaciones
quiero métricas y logs estructurados de conectividad por tenant
para detectar degradación y cambios riesgosos.

Criterios de aceptación:

- métricas mínimas del contrato (`status_total`, `peer_online`, `latency`, `packet_loss`).
- eventos de auditoría (`vpn.create`, `vpn.provision`, `vpn.revoke`, etc).

Tests TDD (primero):

- integración de `/metrics` con labels mínimas.
- integración de `GET /audit-logs` filtrando recursos `vpn.*`.

### NH-NET-11 - Smoke operativo VPN multi-tenant

Como equipo release
quiero smoke automatizado con dos tenants y CIDRs distintos
para validar aislamiento y ciclo de vida.

Criterios de aceptación:

- script `pilot:smoke:vpn` pasa en local.
- valida:
  - create/validate/provision VPN tenant A,
  - create/validate/provision VPN tenant B,
  - rechazo de overlap cross-tenant,
  - health de ambas VPN,
  - emisión de stream-token permitida solo en estado válido.

Tests TDD (primero):

- script smoke falla en rojo sin feature.
- pasa en verde al cerrar historias previas.

## 4) Plan por etapas (TDD real)

## Etapa 0 - Base de pruebas

Objetivo:

- crear harness y fixtures de red/VPN.

Orden:

1. crear seeds de tenants para pruebas de solapamiento.
2. helpers de test para CIDR y transiciones.
3. tests rojos para `NH-NET-01/02`.

Gate de salida:

- suite API actual sigue green.
- nuevos tests de red corren en rojo controlado.

## Etapa 1 - Dominio y validación

Objetivo:

- completar `NH-NET-01/02`.

Ciclo TDD:

1. Red: tests de CIDR/overlap/constraints.
2. Green: implementación mínima en dominio + prisma.
3. Refactor: extraer módulo `network-domain`.

Gate:

- tests de etapa + regresión API en verde.

## Etapa 2 - Lifecycle y endpoints base

Objetivo:

- `NH-NET-03/04/05`.

Ciclo TDD:

1. Red: tests de state machine + RBAC endpoints.
2. Green: endpoints create/validate/provision/health.
3. Refactor: separar service `vpn-lifecycle-service`.

Gate:

- transición inválida cubierta.
- `dryRun` y `apply` verificados.

## Etapa 3 - Integración con cámaras

Objetivo:

- `NH-NET-06/07`.

Ciclo TDD:

1. Red: tests de asociación cámara y gate de stream-token.
2. Green: persistencia y validación de asociación.
3. Refactor: centralizar policy `camera-network-policy`.

Gate:

- ninguna regresión en smoke de stream actual.

## Etapa 4 - Operación y seguridad

Objetivo:

- `NH-NET-08/09`.

Ciclo TDD:

1. Red: tests de policies peers/routes + rotación.
2. Green: endpoints y casos de error.
3. Refactor: provider adapters y secretos.

Gate:

- no hay secretos en payload/logs.
- auditoría completa de mutaciones.

## Etapa 5 - Observabilidad y release

Objetivo:

- `NH-NET-10/11`.

Ciclo TDD:

1. Red: tests de métricas + smoke vpn multi-tenant.
2. Green: métricas y script smoke.
3. Refactor: estabilizar nombres de métricas y dashboards.

Gate:

- `pilot:smoke:vpn` green.
- reportes de métricas por tenant visibles.

## 5) Definition of Done por historia

- contrato actualizado en docs.
- tests TDD agregados (unit + integración mínimo).
- sin regresión en suites existentes (`api`, `stream-gateway`, `event-gateway`).
- logs y errores con código de dominio.
- checklist de seguridad revisado (tenant isolation + secretos).

## 6) Comandos sugeridos por etapa

- `pnpm --filter @app/api test`
- `pnpm --filter @app/stream-gateway test`
- `pnpm pilot:smoke`
- `pnpm pilot:smoke:prod-local`

Cuando exista la suite:

- `pnpm pilot:smoke:vpn`
