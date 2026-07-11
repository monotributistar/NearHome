# Multi-Network Edge Architecture — SPEC

## Why: Problema

NearHome necesita conectar cámaras IP distribuidas geográficamente a un
centro de procesamiento central, cumpliendo tres restricciones:

1. **Trabajo remoto**: el desarrollador (MacBook) no siempre está en la LAN
   de casa. Necesita acceder al sistema desde cualquier lugar.

2. **Segmentación por tenant**: cada deployment de RPi tiene su propia red
   de cámaras (10.0.x.x). Los tenants no deben verse entre sí. Cada RPi
   es un gateway aislado.

3. **Video pesado ≠ control liviano**: los streams RTSP (~8 Mbps por cámara)
   no deben mezclarse con el tráfico de control API. Usar una sola VPN
   para todo encarece, agrega latencia y complica la segmentación.

## What: Alcance

**Dos VPNs separadas**, cada una con un propósito y stack tecnológico
distinto:

| VPN | Tecnología | Propósito | Ancho de banda | Segmentación |
|-----|-----------|-----------|----------------|--------------|
| **Video** | WireGuard site-to-site | Transportar RTSP desde las cámaras hasta el Frame Hub | Alto (8-24 Mbps por RPi) | Cada RPi es un peer distinto |
| **Control** | Tailscale (o balena VPN) | API, health checks, comandos, descubrimiento | Bajo (<1 Mbps) | ACLs por tenant tag |

Además, un **RPi Edge Gateway** que:

- Descubre las cámaras en su red local (10.0.x.x)
- Valida conectividad RTSP, resolución, health
- Reporta los recursos al control plane vía API
- No procesa frames (0 inferencia en el edge)
- Mantiene el túnel WireGuard activo para que el hub acceda al RTSP

### In scope

| Componente | Descripción |
|-----------|-------------|
| WireGuard site-to-site | VPN entre cada RPi y el Home Hub para transporte de RTSP |
| Tailscale mesh | VPN de control entre todos los nodos (Mac, Hub, RPis) |
| RPi Discovery Agent | Detecta cámaras en red local, valida health, reporta vía API |
| RPi Health Keeper | Monitorea conectividad de cámaras, notifica si una cae |
| Segmentación ACL | Tailscale ACLs que aíslan tenants entre sí |
| Home Hub routing | Linux box acepta WireGuard peers + Tailscale + rutea al data plane |
| Mac roaming | Acceso remoto a Coolify + API via Tailscale desde cualquier red |

### Out of scope

- Procesamiento de inferencia en el RPi (se hace en el Home Hub)
- Grabación de video en el edge
- Dashboard de red (Coolify ya cubre monitoreo de servidores)
- Failover automático entre VPNs

## Who: Actores

- **RPi Edge Gateway (balenaOS)** — dispositivo en cada tenant, conecta
  cámaras locales al sistema global
- **Home Hub (Linux RTX 3070)** — centro de procesamiento, recibe RTSP
  de todos los tenants via WireGuard, corre los detectores GPU
- **Control Plane (macOS, roamable)** — API, Coolify, inference-bridge.
  Puede estar en la LAN o remoto via Tailscale
- **Desarrollador** — accede desde MacBook en cualquier red

## User Stories

### US-01: RPi descubre cámaras y las reporta

**Como** RPi Edge Gateway
**Quiero** escanear mi red local (10.0.1.0/24), detectar cámaras RTSP,
validar su estado, y reportarlas al control plane via API
**Para** que el sistema sepa qué cámaras están disponibles sin
configuración manual

```
SCENARIO: Descubrimiento automático de cámaras
  GIVEN un RPi conectado a red 10.0.1.0/24 con 3 cámaras RTSP
  WHEN el discovery-agent se ejecuta
  THEN encuentra las 3 cámaras en el puerto 554
  AND verifica que responden con un frame válido
  AND POSTea a /api/cameras/sync la lista de {ip, rtspUrl, resolution, status}

SCENARIO: Cámara offline reportada
  GIVEN una cámara que antes estaba online
  WHEN el health check falla 3 veces consecutivas
  THEN el RPi reporta status: "offline" via API
  AND el evento se publica en event-gateway como camera.status
```

### US-02: WireGuard transporta RTSP sin bottleneck

**Como** Home Hub
**Quiero** acceder al RTSP de las cámaras de cada RPi como si estuvieran
en mi LAN local
**Para** que el frame grabber capture frames sin latencia extra ni
sobrecarga de encriptación innecesaria

```
SCENARIO: Frame grabber accede a RTSP remoto
  GIVEN un RPi en ubicación remota con cámara en 10.0.1.10:554
  AND WireGuard activo entre RPi y Home Hub
  WHEN el frame grabber en el Home Hub abre rtsp://10.0.1.10:554/...
  THEN el tráfico viaja por WireGuard directamente al RPi
  AND NO pasa por Tailscale ni ningún relay
  AND la latencia es < 5ms sobre el encriptado WireGuard

SCENARIO: Fail de WireGuard no afecta control
  GIVEN WireGuard caído entre RPi-A y Home Hub
  WHEN el RPi-A no puede enviar video
  THEN el health keeper detecta la caída
  AND reporta via Tailscale (control VPN) que WireGuard está down
  AND el sistema marca las cámaras como "video_unavailable"
  AND el control plane sigue funcionando (API, eventos)
```

### US-03: Segmentación por tenant con ACLs

**Como** operador del sistema
**Quiero** que RPi-A (tenant-oficinas) NO pueda ver los recursos de
RPi-B (tenant-logistica), ni viceversa
**Para** que cada tenant esté aislado por seguridad

```
SCENARIO: Tenants aislados
  GIVEN RPi-A en 10.0.1.0/24 y RPi-B en 10.0.2.0/24
  WHEN RPi-A intenta hacer ping a 10.0.2.10 (cámara de RPi-B)
  THEN el paquete NO llega (ACL de Tailscale + ruteo separado)
  WHEN el Home Hub solicita RTSP de ambos
  THEN el Home Hub SÍ puede acceder a ambas redes
  (el Hub tiene tag:admin con permisos totales)

SCENARIO: API por tenant
  GIVEN un request a /api/cameras con X-Tenant-Id: tenant-a
  WHEN el API procesa el request
  THEN solo devuelve las cámaras de tenant-a
  AND las rutas RTSP apuntan a 10.0.1.x (red de tenant-a)
```

### US-04: Mac roaming sin configuración

**Como** desarrollador
**Quiero** abrir mi MacBook en cualquier lugar (casa, café, cliente) y
acceder a Coolify, API, y dashboards de NearHome
**Para** poder trabajar desde cualquier red sin configurar VPN

```
SCENARIO: Acceso remoto desde café
  GIVEN MacBook conectado a WiFi de un café (red NATeada)
  WHEN abro http://100.x.x.x:8000 (Coolify en Home Hub)
  THEN Tailscale conecta directo o via relay DERP
  AND veo el dashboard de Coolify
  WHEN hago curl a http://100.x.x.x:3001/api/cameras
  THEN recibo las cámaras de todos los tenants
  AND NO tengo que abrir puertos en mi router

SCENARIO: Sin Tailscale, sin acceso
  GIVEN MacBook sin Tailscale conectado
  WHEN intento acceder a cualquier servicio
  THEN no hay conexión posible (cero puertos abiertos en router)
```

### US-05: RPi mantiene health de recursos

**Como** RPi Edge Gateway
**Quiero** monitorear constantemente el estado de las cámaras,
la conectividad WireGuard, y el espacio en disco/SD
**Para** que el control plane tenga visibilidad en tiempo real

```
SCENARIO: Health check periódico
  GIVEN RPi con 3 cámaras y WireGuard activo
  WHEN pasa el intervalo de health check (30s)
  THEN prueba cada cámara: rtsp ping → frame sample → calcular bitrate
  AND verifica WireGuard: peer handshake time, bytes tx/rx
  AND verifica disco: uso de SD card, temperatura
  AND POSTea a /api/edge/health con todo el reporte

SCENARIO: Alerta de recurso
  GIVEN SD card del RPi al 92% de uso
  WHEN el health check detecta >90%
  THEN reporta warning via API
  AND el evento se publica como edge.resource.warning
```

## Acceptance Criteria (globales)

1. [ ] RPi balenaOS flasheado con stack edge-gateway
2. [ ] discovery-agent detecta cámaras en red local
3. [ ] WireGuard site-to-site entre RPi y Home Hub
4. [ ] Home Hub accede a RTSP de cualquier RPi como si fuera local
5. [ ] Tailscale mesh conecta: Mac, Home Hub, todos los RPis
6. [ ] ACLs aíslan tenants: RPi-A no ve RPi-B
7. [ ] MacBook accede a Coolify + API desde internet sin configurar nada
8. [ ] RPi reporta health cada 30s via API
9. [ ] Caída de WireGuard se detecta y reporta por separado
10. [ ] Home Hub sirve como gateway para ambos planos (video + control)

## Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| WireGuard bloqueado por firewall corporativo/cliente | Alta | Medio | Tailscale como fallback con DERP relays (menor throughput) |
| RPi con recursos insuficientes para dos VPNs | Media | Alto | RPi 4+ recomendado. WireGuard es liviano (kernel). Tailscale userspace. |
| Routing conflicts entre subnets de tenants | Baja | Alto | Subnets /24 fijas por tenant. 10.0.{tenant_id}.0/24 |
| Pérdida de paquete en WireGuard over internet | Media | Medio | TCP-friendly. Frame grabber reconecta automáticamente. |
| Coolify no gestiona RPis con balenaOS | Baja | Medio | Coolify gestiona el Home Hub. Los RPis se gestionan con openbalena. |
