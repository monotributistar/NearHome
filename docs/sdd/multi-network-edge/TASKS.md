# Multi-Network Edge Architecture — TASKS

## FASE 1 — Home Hub con segmentación (semana 1)

### T1.1 WireGuard en Home Hub

```bash
# Instalar
sudo apt install wireguard

# Generar claves
wg genkey | tee /etc/wireguard/hub.key | wg pubkey > /etc/wireguard/hub.pub

# Crear config /etc/wireguard/wg0.conf
```

**Archivos:** `/etc/wireguard/wg0.conf`, script de peers dinámicos

### T1.2 Tailscale en Home Hub

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --accept-routes --advertise-routes=192.168.0.0/24
tailscale ip -4  # anotar IP
```

**Tags:** `tag:hub`

### T1.3 Configurar ACLs de Tailscale

Editar ACLs en https://login.tailscale.com/admin/acls
Usar las ACLs definidas en el DESIGN

### T1.4 Probar Mac roaming

Desde Mac fuera de casa:
```bash
tailscale up
curl http://100.1.1.1:8000  # Coolify
curl http://100.1.1.1:3001  # API
```

### T1.5 Actualizar docker-compose con IPs de Tailscale

Reemplazar IPs LAN por IPs Tailscale en docker-compose.gpu.yml
y docker-compose.poc.yml

---

## FASE 2 — RPi balenaOS (semana 2)

### T2.1 Flashear balenaOS en RPi

Usar Raspberry Pi Imager o balenaEtcher
Configurar WiFi + openbalena endpoint

### T2.2 Pushear edge-gateway stack

```bash
cd edge-gateway
balena push nearhome-fleet
```

### T2.3 Configurar WireGuard client en RPi

```bash
# Generar claves en el RPi
wg genkey | tee /etc/wireguard/rpi.key | wg pubkey > /etc/wireguard/rpi.pub

# Agregar peer en el Hub
```

### T2.4 Configurar Tailscale en RPi

```bash
tailscale up --auth-key=<key> --hostname=rpi-tenant-a --advertise-routes=10.0.1.0/24
```

**Tags:** `tag:tenant-a`

### T2.5 Probar discovery-agent

Verificar que detecta cámaras en 10.0.1.0/24
Verificar que POSTea a API del Hub

### T2.6 Verificar RTSP via WireGuard

```bash
# En Home Hub
ffprobe rtsp://10.0.1.10:554/stream  # debe funcionar
```

---

## FASE 3 — Health keeper + routing (semana 2-3)

### T3.1 Endpoint API: /api/edge/cameras/sync

Recibe lista de cámaras de cada RPi
Crea o actualiza en DB con tenantId

### T3.2 Endpoint API: /api/edge/health

Recibe health report de cada RPi
Almacena en tabla CameraHealthSnapshot

### T3.3 Health keeper en RPi

Container que cada 30s:
- Testea cada cámara
- Testea WireGuard peer
- Reporta system resources

### T3.4 Dashboard en Coolify

Mostrar estado de cada RPi y sus cámaras

---

## FASE 4 — Exposición internet (semana 3)

### T4.1 Cloudflare Tunnel desde Coolify

Coolify → Settings → Cloudflare Tunnel → Setup

### T4.2 DNS

admin.nearhome.dev → Cloudflare Tunnel → Coolify :8000

### T4.3 Auth

Coolify tiene auth built-in
Para API, usar JWT tokens existentes
