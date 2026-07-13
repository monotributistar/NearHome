# Edge Node Product - DESIGN

## Decision de arquitectura

La arquitectura es factible para una PoC y puede evolucionar a produccion si se
mantienen separados playback, inferencia y persistencia. La ruta canonica es:

```text
Camera LAN
  | RTSP, preferentemente H.264
Edge Node (RPi)
  |-- WireGuard video plane -----------------------------+
  |-- Tailscale/Headscale control plane ----+            |
                                           v            v
                                      Control API   Media ingress
                                                       |
                                                 Frame Grabber
                                                       |
                                             bounded latest-frame queue
                                                       |
                                              Inference Bridge
                                                       |
                                         TensorRT/YOLO on RTX 3070
                                                       |
                         +-----------------------------+----------------+
                         v                             v                v
                   Metadata DB                 Evidence Store    Event Gateway
                                                                        |
                                                               Authorized client
```

## Planos de red

### Video plane

- WireGuard site-to-site, un peer y un CIDR de camara por gateway.
- El hub inicia conexiones RTSP hacia las camaras; no se publican puertos RTSP.
- `AllowedIPs` del hub contiene solo el CIDR asignado al peer.
- Forwarding del edge permite `wg0 -> camera_iface` solo a puertos RTSP/ONVIF
  requeridos y permite trafico de retorno establecido.
- Se usa SNAT cuando las camaras no admiten una ruta de retorno al subnet VPN.
- Los CIDR de camara no pueden superponerse. Si una instalacion ya usa una red
  repetida, se necesita NAT 1:1 por sitio o un proxy RTSP en el edge.

### Control plane

- Tailscale o Headscale transporta registro, heartbeat, discovery, logs y SSH.
- La red de control no anuncia las LAN de camaras.
- ACL default-deny: edge solo puede alcanzar API y observabilidad del hub.
- La VPN no reemplaza autenticacion de aplicacion. Cada edge usa un token rotado
  y ligado a `gatewayId` y `tenantId`.

Balena VPN no debe ser el control plane de producto: sirve para administracion
del dispositivo, pero acopla conectividad funcional al proveedor de flota.

## Edge node

### Servicios

| Servicio                 | Responsabilidad                     | Privilegios                         |
| ------------------------ | ----------------------------------- | ----------------------------------- |
| `discovery-agent`        | ARP/ONVIF, heartbeat, camera health | host network o raw socket acotado   |
| `wireguard-router`       | interfaz WG, rutas y firewall       | `NET_ADMIN`, no privileged completo |
| `tailscale`              | conectividad de control             | tun + estado persistente            |
| `node-exporter` opcional | metricas del host                   | read-only                           |

El agente usa los contratos existentes:

- `POST /api/v1/edge-gateways/register`
- `POST /api/v1/edge-gateways/{id}/heartbeat`
- `POST /api/v1/edge-gateways/{id}/cameras/discover`

Heartbeat y discovery deben ejecutar `deviceAuthPreHandler`. El API obtiene el
tenant desde el gateway autenticado; debe ignorar cualquier `tenantId` enviado
por el dispositivo.

### Estado persistente

- Clave privada WireGuard.
- Estado y clave de Tailscale/Headscale.
- `gatewayId`, token API y version de configuracion aplicada.
- Cache de camaras confirmadas sin passwords en texto plano.

Las claves se generan una vez por dispositivo. La configuracion publica puede
recrearse; la identidad no puede cambiar en cada restart.

### Health model

El heartbeat incluye:

- CPU, memoria, disco, temperatura y uptime.
- Ultimo handshake WireGuard, RX/TX y endpoint observado.
- Estado del control VPN.
- Camaras descubiertas, confirmadas, online y degradadas.
- Latencia de probe RTSP y fallos consecutivos.
- Version de imagen y configuracion.

Se usan estados separados: `controlStatus`, `videoTunnelStatus`, `cameraStatus`
y `configStatus`. Un unico booleano `online` no explica fallos parciales.

## Media ingress y frame grabber

El frame grabber actual sirve para demo, pero no para produccion sin cambios:

- Cada hilo crea actualmente su propio `Semaphore`; no limita concurrencia global.
- `cv2.VideoCapture` ofrece control limitado de timeout, transporte y PTS RTSP.
- Hay dos implementaciones identicas de `_build_multipart`.
- El timestamp actual es hora de captura, no PTS del stream.
- La llamada sincrona al detector bloquea la lectura y aumenta latencia.

Para la PoC se puede mantener OpenCV con un semaphore global y timeouts. Para el
camino de producto se recomienda un proceso FFmpeg/GStreamer por stream que:

1. Decodifique una sola vez.
2. Produzca muestras con `frameId`, PTS y `capturedAt`.
3. Mantenga una cola de capacidad 1-2 por camara.
4. Reemplace el frame pendiente cuando llega uno nuevo.
5. Reconecte con backoff y jitter.
6. Exponga FPS de entrada, FPS muestreado, drops y reconnects.

Playback HLS y sampling pueden compartir el mismo media ingress, pero no deben
transcodificar dos veces. Siempre que sea posible se hace remux del stream H.264;
la RTX 3070 reserva GPU para inferencia y, si hace falta transcode, usa NVENC.

## Inferencia en RTX 3070

Debe existir un solo YOLO productivo. `apps/detector` queda como demo legacy y el
camino canonico usa `inference-bridge -> inference-node-tensorrt`.

Configuracion inicial:

- YOLO11n, 640 px, TensorRT FP16.
- Un engine construido en la misma familia de GPU/runtime donde se ejecuta.
- Concurrencia inicial 1-2, no 8-12 hasta medir consumo y comportamiento del
  engine. La concurrencia HTTP no implica ejecucion GPU paralela segura.
- Warmup al iniciar y readiness solo despues de cargar el engine.
- Batch pequeno opcional cuando no viola el limite de latencia.

Una RTX 3070 normalmente tiene 8 GB de VRAM; el compose no debe declarar 12 GB.
La capacidad se determina con un benchmark de 1, 4, 8 y 12 camaras, midiendo
decode, upload, queue wait, inference y latencia end-to-end por separado.

## Persistencia y entrega

### Metadata

PostgreSQL/Prisma conserva detecciones, eventos, estado y referencias. No debe
crear un `DetectionJob` sintetico con IDs o usuarios hardcodeados por tenant.
Los callbacks internos usan credenciales de servicio y scopes explicitos.

### Evidencia

- Object storage S3-compatible, por ejemplo MinIO en la PoC.
- Ruta: `{tenantId}/{cameraId}/{yyyy/mm/dd}/{eventId}/frame.jpg`.
- Guardar evidencia por policy, no cada muestra negativa.
- TTL y lifecycle por tenant.
- Acceso mediante URL firmada corta; Caddy no sirve directorios multi-tenant
  directamente.
- Para incidentes: clip pre/post evento desde un ring buffer, no secuencias de
  JPEG ilimitadas.

### Clientes

- SSE/WebSocket transporta metadata, nunca frames continuos.
- HLS entrega playback con token y autorizacion por tenant/camera.
- El overlay correlaciona por `frameId`/PTS y dimensiones de origen.

## Backpressure y fallos

| Falla             | Comportamiento                                                   |
| ----------------- | ---------------------------------------------------------------- |
| Camara offline    | backoff, estado degradado, sin loop agresivo                     |
| WireGuard caido   | control sigue reportando; captura se pausa                       |
| Control VPN caida | video puede continuar; heartbeat queda stale                     |
| Detector saturado | descartar frame viejo, nunca cola ilimitada                      |
| Storage caido     | evento metadata con `evidenceStatus=failed`; retry acotado       |
| DB caida          | buffer durable pequeno o error visible; no silenciar excepciones |
| Cliente lento     | no afecta captura ni detector                                    |

## Seguridad minima

- Rotar las claves y passwords actualmente presentes en scripts locales.
- Secrets solo en Docker secrets, Balena variables o un secret manager.
- Aplicar autenticacion de dispositivo a todos los endpoints edge.
- CORS no puede reflejar cualquier origen con credenciales.
- Cifrar credenciales de camara con una clave de aplicacion; Base64 no es cifrado.
- Prohibir acceso directo del cliente a RTSP, detector, DB y filesystem.
- Registrar auditoria de provision, rotacion, cambios de rutas y decommission.

## Estrategia de simulacion

El generador crea N proyectos equivalentes. Cada nodo recibe:

- `tenantId`, `gatewayId` y token unicos.
- LAN `/24` y camara MediaMTX propias.
- IP WireGuard `/32` y keypair persistente.
- namespace de red y volumen de estado propios.

El harness prueba conectividad positiva hub->camera y negativa edge->edge. Docker
Desktop no reproduce fielmente routing kernel Linux; las pruebas finales de WG,
iptables y throughput se ejecutan en la Linux box o en VMs Linux.

## Go/no-go para produccion inicial

La arquitectura pasa a piloto solo si completa 24 horas con carga objetivo, sin
crecimiento de cola o memoria, con aislamiento negativo, restauracion despues de
reinicios y evidencia autorizada. BalenaOS se adopta solo si simplifica OTA y
fleet operations sin romper routing, persistencia de claves o observabilidad.
