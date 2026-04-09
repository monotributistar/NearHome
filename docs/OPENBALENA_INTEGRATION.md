# NearHome Stack con openbalena - Arquitectura Completa

Este documento describe cómo integrar openbalena como parte del stack de NearHome para gestionar los Edge Gateways.

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────────┐
│                          NearHome Stack                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐│
│   │   API       │    │   Dashboard │    │   openbalena Server    ││
│   │   Server    │    │   UI        │    │   (self-hosted)        ││
│   │   :3001     │    │   :5173     │    │   :3000                ││
│   └──────┬──────┘    └──────┬──────┘    └───────────┬─────────────┘│
│          │                │                     │                  │
│          └────────────────┼─────────────────────┘                  │
│                           │                                          │
└───────────────────────────┼────────────────────────────────────────┘
                            │
                            │ HTTPS/WSS
                            │
┌───────────────────────────┼────────────────────────────────────────┐
│                           │    Edge Gateway (Raspberry Pi 3B+)    │
│                           ▼                                         │
│   ┌─────────────────────────────────────────────────────────────┐ │
│   │                    balenaOS                                  │ │
│   │  ┌──────────────────────────────────────────────────────┐   │ │
│   │  │         Discovery Agent Container                     │   │ │
│   │  │  - Camera discovery (ARP + ONVIF)                     │   │ │
│   │  │  - Heartbeat reporting                                 │   │ │
│   │  │  - Tunnel management                                   │   │ │
│   │  └──────────────────────────────────────────────────────┘   │ │
│   │                                                              │ │
│   │  ┌──────────────────────────────────────────────────────┐   │ │
│   │  │         balena Supervisor                             │   │ │
│   │  │  - Device health monitoring                            │   │ │
│   │  │  - OTA updates                                          │   │ │
│   │  │  - Container management                                │   │ │
│   │  └──────────────────────────────────────────────────────┘   │ │
│   │                                                              │ │
│   │  ┌──────────────────────────────────────────────────────┐   │ │
│   │  │         balenaVPN (built-in)                          │   │ │
│   │  │  - Automatic connection                                │   │ │
│   │  │  - Remote access                                       │   │ │
│   │  │  - Tunnel to cameras                                   │   │ │
│   │  └──────────────────────────────────────────────────────┘   │ │
│   └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            │ Local Network
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Camera Subnet                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                           │
│  │Camera 1  │  │Camera 2  │  │Camera N  │   IP Cameras (RTSP/ONVIF)│
│  │ :554     │  │ :554     │  │ :554     │                           │
│  └──────────┘  └──────────┘  └──────────┘                           │
└─────────────────────────────────────────────────────────────────────┘
```

## Componentes del Stack

### 1. openbalena Server

El servidor openbalena se despliega como parte de la infraestructura de NearHome:

```bash
cd NearHome/infra/openbalena
docker-compose up -d
```

**Servicios incluidos:**

- `api` - API REST para gestión de dispositivos
- `vpn` - Servidor VPN para conectividad de dispositivos
- `registry` - Registro Docker para aplicaciones
- `db` - PostgreSQL para datos de dispositivos
- `redis` - Cache y pub/sub
- `s3` - MinIO para almacenamiento de imágenes

### 2. NearHome API

La API de NearHome (`:3001`) es donde se registran los edge gateways y reciben las cámaras descubiertas.

**Integración:**

- El Discovery Agent reporta a la API de NearHome
- Las cámaras descubiertas se almacenan en `DiscoveredCamera`
- Los heartbeats actualizan el estado del dispositivo

### 3. Raspberry Pi con balenaOS

Cada Raspberry Pi 3B+ ejecuta:

- **balenaOS** - Sistema operativo optimizado
- **balena Supervisor** - Gestor de contenedores
- **Discovery Agent** - Tu aplicación Python

---

## Deployment Paso a Paso

### Paso 1: Desplegar openbalena

```bash
# Navegar al directorio
cd NearHome/infra/openbalena

# Copiar configuración
cp .env.example .env
# Editar .env con tus valores

# Iniciar servicios
docker-compose up -d

# Verificar
docker-compose ps
```

### Paso 2: Configurar DNS Local

Agrega a tu `/etc/hosts` (para desarrollo):

```bash
# Para desarrollo local
echo "127.0.0.1 api.balena vpn.balena registry.balena" | sudo tee -a /etc/hosts
```

Para producción, configura tu servidor DNS.

### Paso 3: Crear Fleet

Accede al panel de openbalena (puerto 3000) y:

1. Crea una fleet llamada "edge-gateways"
2. Configura el device type como "raspberrypi3"
3. Genera un API key de provisioning

### Paso 4: Preparar Raspberry Pi

**Opción A: Con balenaEtcher**

1. Descarga balenaOS para Raspberry Pi 3
2. Flashea la SD card
3. Copia `config.json` a la partición boot

**Opción B: Desde Raspberry Pi OS existente**

```bash
# En tu Raspberry Pi con Raspberry Pi OS
curl -sL https://raw.githubusercontent.com/balena-os/balena-os/master/scripts/boardsupport.py | \
  bash -s -- raspberrypi3 \
  openbalena
```

### Paso 5: Desplegar Aplicación

```bash
# Desde tu computadora
cd NearHome/edge-gateway

# Push a la fleet
balena push edge-gateways
```

### Paso 6: Registrar con API de NearHome

Cuando el dispositivo se conecte, you'll need to register it with the NearHome API:

```bash
# Después de que el dispositivo se conecte a openbalena
# Obtén el balenaDeviceUUID del dispositivo
DEVICE_UUID=$(ssh root@<device-ip> "cat /proc/cpuinfo | grep Serial | cut -d' ' -f2")

# Registra con la API de NearHome
curl -X POST http://localhost:3001/api/v1/edge-gateways/register \
  -H 'Content-Type: application/json' \
  -d "{
    \"balenaDeviceUUID\": \"$DEVICE_UUID\",
    \"deviceName\": \"rpi-gateway-01\",
    \"tenantId\": \"YOUR_TENANT_ID\",
    \"balenaFleetId\": \"FLEET_ID\"
  }"
```

---

## Configuración de Red

### openbalena → Internet

El servidor openbalena necesita:

- Puerto 80 (HTTP API)
- Puerto 443 (HTTPS - si configuras TLS)
- Puertos 30000-40000 (UDP para VPN)

### Raspberry Pi → openbalena

El Raspberry Pi se conecta a:

- `api.balena` - API de gestión
- `vpn.balena` - Servidor VPN

### Raspberry Pi → Cámaras

El Discovery Agent necesita acceso a:

- Subred local de cámaras
- Puertos: 554 (RTSP), 80/8000 (ONVIF)

---

## Integración con NearHome API

### Flujo de Datos

1. **Discovery**: El agente descubre cámaras → reporta a API
2. **Confirmación**: El usuario confirma cámaras → API crea Camera
3. **Heartbeat**: El agente reporta estado → API actualiza
4. **Túneles**: Se crean túneles VPN → acceso a RTSP

### Endpoints Utilizados

| Endpoint                                     | Método | Propósito              |
| -------------------------------------------- | ------ | ---------------------- |
| `/api/v1/edge-gateways/register`             | POST   | Registrar dispositivo  |
| `/api/v1/edge-gateways/:id/heartbeat`        | POST   | Estado del dispositivo |
| `/api/v1/edge-gateways/:id/cameras/discover` | POST   | Cámaras encontradas    |
| `/api/v1/edge-gateways/:id/cameras/confirm`  | POST   | Confirmar cámara       |

---

## Ambiente de Producción

Para un ambiente de producción real:

1. **DNS**: Configura registros DNS reales para api.balena, vpn.balena
2. **TLS**: Configura certificados SSL/TLS
3. **Firewall**: Configura reglas de firewall apropiadas
4. **VPN**: El tráfico entre dispositivos y openbalena está encriptado
5. **Backup**: Configura backup regular de la base de datos

---

## Troubleshooting

### Dispositivo no aparece en openbalena

- Verifica conexión a internet
- Verifica que config.json sea correcto
- Revisa logs: `balena logs <device-uuid>`

### No puede alcanzar las cámaras

- Verifica que el dispositivo esté en la misma subred
- Verifica que las cámaras tengan IPs en el mismo rango

### No puede alcanzar la API de NearHome

- Verifica que la API esté corriendo
- Verifica la URL en la configuración del dispositivo
