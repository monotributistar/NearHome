# Contrato VPN y Espacios de Red por Tenant (NH-NET-01)

Fecha de actualización: `2026-04-05`
Estado: `proposed` (contrato objetivo para implementación)

## 1) Objetivo

Definir el manejo de ciclo de vida de VPNs y espacios de red por tenant para:

- asociar cámaras remotas a una VPN tenant-scoped,
- conectar dicha VPN con la infraestructura NearHome,
- operar onboarding, cambios, rotación y baja con trazabilidad y controles de seguridad.

## 2) Alcance

- Dominio de conectividad tenant-scoped.
- Contrato de red (CIDRs, rutas permitidas, DNS opcional).
- Ciclo de vida operativo de VPN.
- Estados, transiciones, validaciones y errores.
- Endpoints de control-plane para gestión y observabilidad.

Fuera de alcance en esta versión:

- elección obligatoria de tecnología VPN (WireGuard/IPsec/Tailscale).
- automation específica de proveedor cloud.

## 3) Modelo de dominio

### 3.1 Entidades

- `TenantVpn`
  - `id`
  - `tenantId`
  - `name`
  - `provider` (`wireguard|ipsec|tailscale|custom`)
  - `topology` (`site_to_site|hub_spoke|mesh`)
  - `status` (`draft|validating|provisioning|active|degraded|revoking|revoked|failed`)
  - `lifecycleStatusReason?`
  - `credentialsRef` (referencia a vault/secret manager)
  - `tunnelInterface` (ej: `wg0`)
  - `createdAt`, `updatedAt`, `activatedAt?`, `revokedAt?`

- `TenantNetworkSpace`
  - `id`
  - `tenantId`
  - `vpnId`
  - `spaceType` (`camera_lan|edge_nodes|operations|reserved`)
  - `cidr` (ej: `10.42.10.0/24`)
  - `gatewayIp?`
  - `dnsServers[]`
  - `isPrimary`
  - `status` (`planned|allocated|announced|active|retired`)
  - `createdAt`, `updatedAt`

- `TenantVpnRoutePolicy`
  - `id`
  - `tenantId`
  - `vpnId`
  - `direction` (`tenant_to_nearhome|nearhome_to_tenant`)
  - `destinationCidr`
  - `nextHop?`
  - `priority`
  - `status` (`pending|active|blocked|retired`)

- `TenantVpnPeer`
  - `id`
  - `tenantId`
  - `vpnId`
  - `peerId`
  - `peerRole` (`edge_gateway|camera_router|node_host`)
  - `publicKeyRef`
  - `allowedCidrs[]`
  - `endpoint`
  - `status` (`pending|active|offline|revoked`)
  - `lastHandshakeAt?`

### 3.2 Reglas de aislamiento

- Toda VPN pertenece a un único `tenantId`.
- No se permite superposición de CIDRs entre tenants dentro del dominio NearHome gestionado.
- Rutas de un tenant no pueden anunciar/alcanzar CIDRs de otro tenant.
- Las políticas por defecto son deny-all y se habilita solo allowlist explícita.

## 4) Ciclo de vida de VPN

### 4.1 Estados

- `draft`: definición inicial sin conectividad activa.
- `validating`: chequeo de solapamiento CIDR, formato, reachability plan.
- `provisioning`: creación de túnel, peers, rutas y ACL.
- `active`: túnel operativo con health OK.
- `degraded`: túnel operativo parcial (latencia/pérdida/peer offline).
- `failed`: no se pudo provisionar o recuperar estado.
- `revoking`: retiro controlado de rutas, peers y credenciales.
- `revoked`: VPN dada de baja.

### 4.2 Transiciones permitidas

- `draft -> validating`
- `validating -> provisioning|failed`
- `provisioning -> active|degraded|failed`
- `active -> degraded|revoking`
- `degraded -> active|failed|revoking`
- `failed -> validating|revoking`
- `revoking -> revoked|failed`

No se permite transición directa a `active` sin `validating + provisioning`.

## 5) Contrato de espacios de red

### 5.1 Reglas de CIDR

- CIDR válido IPv4/IPv6.
- Prohibido CIDR `/0`.
- Prohibido solapamiento con:
  - rangos core NearHome reservados,
  - CIDRs activos de otros tenants,
  - CIDRs ya asociados a la misma VPN en distinto `spaceType` (si overlap no explícitamente permitido).

### 5.2 Ruteo mínimo

- `tenant_to_nearhome`: solo destinos necesarios (`api/event-gateway/stream-gateway` internos definidos por ACL).
- `nearhome_to_tenant`: solo segmentos de cámaras/nodos declarados.
- Toda ruta debe estar vinculada a una `TenantVpnRoutePolicy`.

### 5.3 NAT y puertos

- Modo recomendado: sin exposición pública directa de cámaras.
- Inbound desde internet a cámaras: prohibido.
- Management ports permitidos solo desde subred de operaciones NearHome.

## 6) Contrato HTTP propuesto (Control Plane)

Base: `/v1/network`

### 6.1 Crear VPN

- `POST /tenants/:tenantId/vpns`

Request:

```json
{
  "name": "tenant-a-main-vpn",
  "provider": "wireguard",
  "topology": "site_to_site",
  "networkSpaces": [
    { "spaceType": "camera_lan", "cidr": "10.42.10.0/24", "isPrimary": true }
  ]
}
```

Response:

```json
{
  "data": {
    "id": "vpn_01",
    "tenantId": "tenant_a",
    "status": "draft"
  }
}
```

### 6.2 Validar plan de red

- `POST /tenants/:tenantId/vpns/:vpnId/validate`

Response:

```json
{
  "data": {
    "vpnId": "vpn_01",
    "status": "validating",
    "checks": [
      { "name": "cidr_overlap", "ok": true },
      { "name": "reserved_ranges", "ok": true }
    ]
  }
}
```

### 6.3 Provisionar conectividad

- `POST /tenants/:tenantId/vpns/:vpnId/provision`

Request:

```json
{
  "dryRun": false,
  "changeTicket": "CHG-2026-0412"
}
```

Response:

```json
{
  "data": {
    "vpnId": "vpn_01",
    "status": "provisioning"
  }
}
```

### 6.4 Estado y salud de VPN

- `GET /tenants/:tenantId/vpns/:vpnId`
- `GET /tenants/:tenantId/vpns/:vpnId/health`

Health response:

```json
{
  "data": {
    "vpnId": "vpn_01",
    "status": "active",
    "latencyMsP95": 32,
    "packetLossPct": 0.1,
    "peerOnline": 3,
    "peerTotal": 3,
    "checkedAt": "ISO-8601"
  }
}
```

### 6.5 Rotación de credenciales/keys

- `POST /tenants/:tenantId/vpns/:vpnId/rotate-credentials`

Request:

```json
{
  "reason": "scheduled_rotation",
  "gracePeriodSeconds": 3600
}
```

### 6.6 Revocar VPN

- `POST /tenants/:tenantId/vpns/:vpnId/revoke`

Request:

```json
{
  "reason": "tenant_offboarding"
}
```

Response:

```json
{
  "data": {
    "vpnId": "vpn_01",
    "status": "revoking"
  }
}
```

## 7) Gestión de cámaras sobre VPN

- `Camera` debe poder referenciar:
  - `vpnId`
  - `networkSpaceId`
  - `privateRtspUrl` (host interno enrutable por VPN)
- Reglas:
  - no emitir stream token si `vpn.status` no está en `active|degraded`.
  - en `degraded`, permitir con warning operativo y auditoría.
  - en `failed|revoking|revoked`, bloquear onboarding/validación de cámara asociada.

## 8) Errores estándar de red/VPN

- `409 VPN_CIDR_OVERLAP`
- `409 VPN_RESERVED_RANGE_CONFLICT`
- `409 VPN_STATUS_TRANSITION_INVALID`
- `409 VPN_ALREADY_ACTIVE`
- `422 VPN_NETWORK_SPACE_INVALID`
- `422 VPN_ROUTE_POLICY_INVALID`
- `503 VPN_PROVIDER_UNAVAILABLE`
- `503 VPN_HEALTH_CHECK_FAILED`

Shape:

```json
{
  "code": "VPN_CIDR_OVERLAP",
  "message": "network space overlaps another tenant CIDR",
  "details": {
    "cidr": "10.42.10.0/24",
    "conflictWithTenantId": "tenant_b"
  }
}
```

## 9) Observabilidad y auditoría

### 9.1 Métricas mínimas

- `nearhome_vpn_status_total{tenantId,status}`
- `nearhome_vpn_peer_online_total{tenantId,vpnId}`
- `nearhome_vpn_latency_ms_p95{tenantId,vpnId}`
- `nearhome_vpn_packet_loss_pct{tenantId,vpnId}`
- `nearhome_vpn_provision_attempts_total{result}`
- `nearhome_vpn_route_conflicts_total`

### 9.2 Auditoría mínima

Eventos auditables:

- `vpn.create`
- `vpn.validate`
- `vpn.provision`
- `vpn.rotate_credentials`
- `vpn.revoke`
- `vpn.route_policy.update`
- `vpn.network_space.update`

Campos mínimos:

- `tenantId`, `vpnId`, `actorUserId`, `requestId`, `changeTicket?`, `result`.

## 10) Seguridad operativa

- Secretos de VPN siempre en vault/secret manager (nunca en plaintext en DB ni logs).
- Rotación obligatoria de claves/credenciales por política (ej: 90 días).
- ACL explícita por tenant, sin rutas implícitas globales.
- Runbook de rollback para cambios de rutas/peers.

## 11) Plan incremental de implementación

1. Fase 1 (MVP conectividad):
- CRUD VPN + validación CIDR + estados + health básico.
- asociación cámara -> vpn/networkSpace.

2. Fase 2 (operación):
- route policies y rotación de credenciales.
- auditoría completa + dashboards de conectividad tenant.

3. Fase 3 (hardening):
- auto-remediation de peers offline.
- validación pre-deploy de conflictos en tiempo real.
- SLOs formales de conectividad por tenant.
