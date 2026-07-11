# Multi-Network Edge Architecture — DESIGN

## Arquitectura general

```
┌───────────────────────────────┐       ┌─────────────────────────────────┐
│          MAC ROAMING          │       │         INTERNET                │
│  (cualquier red: casa, café)  │       │  Cloudflare Tunnel (solo web)   │
│                               │       │                                 │
│  Coolify UI                   │       │  admin.nearhome.dev → :8080     │
│  API cliente                  │       └───────────┬─────────────────────┘
│  Terminal SSH                 │                   │
└──────────┬────────────────────┘                   │
           │ Tailscale (control)                    │
           │ 100.3.3.3                              │
           ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       TAILNET (100.x.x.x)                            │
│                                                                      │
│  ACLs: admin → todo | tenant-a → hub:3001 | tenant-b → hub:3001     │
│                                                                      │
│  ◄── Mac roaming ──►   ◄── VPS futuro ──►                           │
│                                                                      │
│  ┌────────────────────────────────────────────────┐                  │
│  │           HOME HUB (Linux RTX 3070)            │                  │
│  │           tailscale IP: 100.1.1.1              │                  │
│  │           LAN IP: 192.168.0.156                │                  │
│  │                                                │                  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────────┐   │                  │
│  │  │ Coolify │ │  API     │ │ inference-    │   │                  │
│  │  │ :8000   │ │  :3001   │ │ bridge :8090  │   │                  │
│  │  └─────────┘ └──────────┘ └───────────────┘   │                  │
│  │                                                │                  │
│  │  ┌────────────────────────────────────────┐   │                  │
│  │  │ WireGuard (escucha :51820, peers TEN)  │   │                  │
│  │  │   peer rpi-a → 10.0.1.0/24             │   │                  │
│  │  │   peer rpi-b → 10.0.2.0/24             │   │                  │
│  │  │   peer rpi-c → 10.0.3.0/24             │   │                  │
│  │  └────────────────────────────────────────┘   │                  │
│  │                                                │                  │
│  │  Frame Hub recibe RTSP de 10.0.1.x, 10.0.2.x  │                  │
│  │  → frames a GPU nodes via LAN (0 overhead)    │                  │
│  └────────────────────────────────────────────────┘                  │
│                      │                         │                    │
│              WireGuard│                         │ Tailscale          │
│              (video)  │                         │ (control)          │
┌───────────────────────▼──┐        ┌──────────────▼───────────────┐   │
│  RPi-A (balenaOS)        │        │  RPi-B (balenaOS)            │   │
│  tailscale: 100.2.2.2    │        │  tailscale: 100.4.4.4       │   │
│  wg peer: 10.0.1.1       │        │  wg peer: 10.0.2.1          │   │
│                          │        │                              │   │
│  discovery-agent         │        │  discovery-agent             │   │
│  health-keeper           │        │  health-keeper               │   │
│                          │        │  NO puede ver 10.0.2.x      │   │
│  Red local: 10.0.1.0/24 │        │  Red local: 10.0.2.0/24      │   │
│  ┌─ Cámara 10.0.1.10    │        │  ┌─ Cámara 10.0.2.10         │   │
│  └─ Cámara 10.0.1.11    │        │  └─ Cámara 10.0.2.11         │   │
└──────────────────────────┘        └──────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

## Componentes

### 1. Home Hub (Linux RTX 3070)

El centro del sistema. Corre:

| Servicio | Función | Red |
|----------|---------|-----|
| Coolify :8000 | Orquestador, dashboard | Tailscale + LAN |
| API :3001 | Control plane NearHome | Tailscale + LAN |
| inference-bridge :8090 | Ruteo de detecciones | LAN |
| Frame Hub :8100 | Recibe frames, orquesta pipelines | LAN |
| GPU nodes :8091-:8093 | YOLO, TensorRT, MediaPipe | LAN |
| WireGuard :51820 | VPN de video con RPis | Internet + LAN |
| Tailscale | VPN de control, mesh | Internet |

**WireGuard config:**

```ini
# /etc/wireguard/wg0.conf
[Interface]
Address = 10.0.0.1/24
ListenPort = 51820
PrivateKey = <hub-private-key>

# RPi-A (tenant-oficinas)
[Peer]
PublicKey = <rpi-a-public>
AllowedIPs = 10.0.1.0/24
Endpoint = rpi-a.dyndns.org:51820
PersistentKeepalive = 25

# RPi-B (tenant-logistica)
[Peer]
PublicKey = <rpi-b-public>
AllowedIPs = 10.0.2.0/24
Endpoint = rpi-b.dyndns.org:51820
PersistentKeepalive = 25
```

**Tailscale ACLs:**

```json
{
  "groups": {
    "group:admin": ["monotributistar@github"],
  },
  "tagOwners": {
    "tag:admin":     ["group:admin"],
    "tag:hub":       ["group:admin"],
    "tag:tenant-a":  ["group:admin"],
    "tag:tenant-b":  ["group:admin"],
  },
  "acls": [
    // Admin puede todo (macOS + hub)
    {"action": "accept", "src": ["tag:admin", "tag:hub"], "dst": ["*:*"]},

    // Tenants solo llegan a puertos específicos del hub
    {"action": "accept", "src": ["tag:tenant-a"],
     "dst": ["tag:hub:80,443,3001,8000,8080,8090"]},

    {"action": "accept", "src": ["tag:tenant-b"],
     "dst": ["tag:hub:80,443,3001,8000,8080,8090"]},

    // Tenants NO se ven entre sí (default deny)
  ]
}
```

### 2. RPi Edge Gateway (balenaOS)

Cada RPi usa balenaOS con dos contenedores Docker:

**A. discovery-agent** (Python, ya existe en edge-gateway/)

```python
# Loop principal
while True:
    # 1. Escanear red local en busca de cámaras RTSP
    cameras = scan_rtsp_devices("10.0.1.0/24")

    # 2. Validar cada una
    for cam in cameras:
        cam["status"] = test_rtsp_connection(cam["url"])
        cam["resolution"] = get_resolution(cam["url"])
        cam["bitrate"] = estimate_bitrate(cam["url"])

    # 3. Reportar al Hub via API (Tailscale → internet)
    http.post(
        "http://100.1.1.1:3001/api/edge/cameras/sync",
        json={"tenantId": TENANT_ID, "cameras": cameras},
    )

    # 4. Exponer RTSP — WireGuard ya lo hace automático
    # (el hub accede a rtsp://10.0.1.10:554 por WireGuard)

    sleep(30)
```

**B. health-keeper** (nuevo)

```python
while True:
    # Monitorear cada cámara
    for cam in registered_cameras():
        status = test_rtsp_reachable(cam["url"])
        report_health(cam["id"], status)

    # Monitorear WireGuard
    wg_status = check_wireguard_peer("10.0.0.1")  # Hub
    report_wireguard_health(wg_status)

    # Monitorear recursos del RPi
    report_system_health({
        "cpu": cpu_percent(),
        "disk": disk_usage("/"),
        "temp": get_cpu_temperature(),
        "uptime": uptime(),
    })

    sleep(30)
```

### 3. WireGuard site-to-site (video plane)

Cada RPi tiene su propia subnet /24 fija:

| Tenant | Subnet RPi | WireGuard IP | VLAN ID (futuro) |
|--------|-----------|-------------|-------------------|
| tenant-oficinas | 10.0.1.0/24 | 10.0.1.1 | VLAN 100 |
| tenant-logistica | 10.0.2.0/24 | 10.0.2.1 | VLAN 200 |
| tenant-nuevo | 10.0.N.0/24 | 10.0.N.1 | VLAN N*100 |

**Config en el RPi:**

```ini
[Interface]
Address = 10.0.1.1/24
ListenPort = 51820
PrivateKey = <rpi-private>

[Peer]
PublicKey = <hub-public>
AllowedIPs = 10.0.0.0/8    # Toda la red WireGuard
Endpoint = hub.dyndns.org:51820
PersistentKeepalive = 25
```

### 4. Tailscale (control plane)

Cada nodo se une a la misma tailnet:

```bash
# Home Hub
sudo tailscale up --accept-routes --advertise-routes=192.168.0.0/24

# Cada RPi (balena container)
tailscale up --auth-key=<key> --hostname=rpi-tenant-a

# macOS
tailscale up --accept-routes
```

## Data flow completo

```
Cámara 10.0.1.10:554 (red RPi-A, LAN local)
    │
    │ RTSP nativo, sin encriptar (red local del RPi)
    ▼
RPi-A (WireGuard peer 10.0.1.1)
    │
    │ WireGuard encriptado por internet
    ▼
Home Hub (WireGuard peer 10.0.0.1)
    │
    │ El hub ve rtsp://10.0.1.10:554 como si fuera local
    ▼
Frame Grabber (en Home Hub, LAN 192.168.0.x)
    │
    │ JPEG frames por LAN (0 overhead VPN)
    ▼
Frame Hub → Pipeline Runner → GPU nodes
    │
    │ Resultados JSON por LAN
    ▼
API / Event Gateway
    │
    │ Detecciones, eventos (JSON, < 1 Mbps)
    ▼
Tailscale (control, encriptado)
    │
    ├──► macOS (roaming)
    └──► Coolify (dashboard)
```

## Plan de implementación

### Fase 1 — Home Hub con segmentación (semana 1)

1. Instalar WireGuard en Linux box
2. Configurar como server WireGuard (escucha :51820)
3. Instalar Tailscale en Linux box
4. Configurar ACLs de Tailscale
5. Probar conectividad desde Mac remoto

### Fase 2 — RPi balenaOS (semana 2)

1. Flashear SD con balenaOS
2. Pushear edge-gateway stack a openbalena
3. Configurar WireGuard client en RPi
4. Configurar Tailscale en RPi
5. Probar discovery-agent detecta cámaras
6. Verificar que hub accede a RTSP via WireGuard

### Fase 3 — Health keeper + routing (semana 2-3)

1. Implementar health-keeper en RPi
2. Endpoint /api/edge/cameras/sync en el API
3. Endpoint /api/edge/health para reportes
4. Dashboard en Coolify con estado de cada RPi

### Fase 4 — Exposición internet (semana 3)

1. Cloudflare Tunnel desde Coolify
2. DNS para admin.nearhome.dev
3. Autenticación para acceso web

## Trade-offs

### WireGuard vs Tailscale para video

| | WireGuard | Tailscale |
|--|-----------|-----------|
| Throughput | Nativo kernel, ~900 Mbps | Userspace, ~200-400 Mbps |
| Setup | Manual (claves, peers) | Automático (auth web) |
| Segmentación | Subnets fijas /24 | ACLs declarativas |
| NAT traversal | Necesita DDNS/STUN | Built-in (DERP relays) |
| Ideal para | Video, frames, bulk data | Control, API, roaming |

**Decisión:** WireGuard para video (rendimiento), Tailscale para
control (flexibilidad + ACLs).

### balenaOS vs Raspberry Pi OS

| | balenaOS | RPi OS |
|--|----------|--------|
| Gestión remota | Native (dashboard) | SSH manual |
| Actualizaciones | OTA automáticas | apt upgrade |
| Docker | Built-in | Instalar aparte |
| Confiabilidad | Read-only rootfs | SD corruption risk |
| Ideal para | Producción, flota | Dev, experimentación |

**Decisión:** balenaOS. Ya tenés openbalena server, es el camino
correcto para RPis en producción.

## Recursos existentes que se reutilizan

| Activo | Dónde está |
|--------|-----------|
| openbalena server | infra/openbalena/ |
| edge-gateway stack | edge-gateway/ |
| discovery-agent | edge-gateway/discovery-agent/ |
| wireguard-router | edge-gateway/wireguard-router/ |
| deploy-to-pi.sh | edge-gateway/deploy-to-pi.sh |
| docker-compose.gpu.yml | infra/docker-compose.gpu.yml |
| Tailscale en macOS | Ya instalado |
| Coolify en Linux box | Ya instalado |
