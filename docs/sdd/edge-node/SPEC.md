# Edge Node Product - SPEC

## Objetivo

Entregar una PoC funcional que conecte camaras IP remotas con NearHome sin
exponer la LAN del cliente a internet. Cada sitio usa una Raspberry Pi como
gateway; la Linux box con RTX 3070 recibe los streams, ejecuta deteccion y
publica eventos y evidencia a clientes autorizados.

La PoC valida el siguiente camino completo:

```text
Camera -> Edge Node -> WireGuard -> Frame Grabber -> Detector
       -> Metadata DB + Evidence Storage -> API/Event Gateway -> Client
```

## Principios

1. El edge enruta video, descubre recursos y reporta salud; no hace inferencia.
2. Video y control tienen planos independientes y fallos independientes.
3. El sistema procesa muestras recientes; nunca acumula una cola de frames viejos.
4. La base guarda metadata. Las imagenes y clips se guardan como objetos con TTL.
5. Cada gateway y cada request llevan identidad de dispositivo y tenant.
6. La PoC usa Raspberry Pi OS Lite 64-bit y Docker Compose. BalenaOS se evalua
   despues de probar el mismo stack en hardware y en simulacion.

## Alcance PoC

- Dos edge nodes simulados, cada uno con una LAN y una camara aisladas.
- Un edge node real en Raspberry Pi 4 o superior.
- WireGuard site-to-site para RTSP entre edge y Linux box.
- Tailscale o Headscale para heartbeat, discovery y operacion remota.
- Descubrimiento ARP/ONVIF y confirmacion manual de credenciales/URL RTSP.
- Frame sampling configurable por camara, inicialmente 1 FPS.
- YOLO sobre RTX 3070 mediante un unico inference node canonico.
- Persistencia de detecciones y evidencia asociada a eventos.
- SSE autenticado para actualizacion del cliente y HLS para visualizacion.
- Metricas y alarmas basicas de edge, VPN, captura, inferencia y storage.

## Fuera de alcance PoC

- Analizar todos los frames de todas las camaras.
- Grabacion continua 24x7 y NVR completo.
- Alta disponibilidad multi-hub o failover automatico entre VPNs.
- Auto-scaling de GPU y orquestacion Kubernetes.
- Inferencia en Raspberry Pi.
- Usar openBalena como requisito para demostrar el producto.

## Casos de uso prioritarios

### UC-01 Provisionar un sitio

Un operador registra el gateway, lo asigna a un tenant, configura ambas VPN y
confirma al menos una camara descubierta. Ningun secreto se incluye en imagenes,
scripts o repositorio.

### UC-02 Detectar y notificar

Con una camara online, el hub captura una muestra, ejecuta YOLO, persiste la
metadata, guarda evidencia solo cuando la policy lo requiere y entrega un evento
al cliente. Todos los artefactos conservan `tenantId`, `cameraId`, `frameId` y
`capturedAt`.

### UC-03 Ver video en vivo

El cliente obtiene un token de playback y reproduce HLS. El stream de playback
no depende del detector; una inferencia lenta no debe detener video en vivo.

### UC-04 Recuperarse de una interrupcion

Si RTSP, WireGuard o el detector se interrumpen, el componente reconecta con
backoff. La cola de captura descarta frames vencidos y el control plane informa
el estado degradado sin confundirlo con una camara eliminada.

### UC-05 Aislar tenants

Un edge no puede alcanzar redes de camara, endpoints de control ni evidencia de
otro tenant. El hub puede alcanzar solo los CIDR y puertos declarados para cada
peer. El API deriva el tenant de la identidad autenticada, no del body.

## Requisitos no funcionales

| Area                   |                      Criterio PoC |          Objetivo de producto inicial |
| ---------------------- | --------------------------------: | ------------------------------------: |
| Camaras                |                     4 simultaneas | 8-12 por RTX 3070, sujeto a benchmark |
| Sampling               |                  1 FPS por camara |                  1-5 FPS segun policy |
| Latencia deteccion p95 |                           < 1.5 s |                              < 750 ms |
| Evento end-to-end p95  |                             < 3 s |                               < 1.5 s |
| Recuperacion RTSP      |                            < 60 s |                                < 30 s |
| Heartbeat edge         |                         cada 30 s |                             cada 30 s |
| Perdida de control     |                    no corta video |                        no corta video |
| Perdida de video       |              control sigue online |                  control sigue online |
| Aislamiento            | pruebas negativas entre 2 tenants |                           obligatorio |
| Retencion evidencia    |  TTL configurable, default 7 dias |                     policy por tenant |

Los numeros de capacidad no son promesas hasta ejecutar el benchmark con los
codecs, resoluciones y modelos del piloto.

## Criterios de aceptacion

1. Dos simuladores levantan desde cero con identidades y claves persistentes.
2. La Linux box abre ambos RTSP exclusivamente por WireGuard.
3. La API rechaza heartbeat y discovery sin token o con token de otro gateway.
4. Un edge no puede acceder a la LAN de camaras del otro.
5. Una Raspberry Pi real mantiene ambos planos durante una prueba de 8 horas.
6. Cuatro camaras a 1 FPS cumplen latencia p95 y no generan backlog creciente.
7. Reiniciar edge, WireGuard, frame grabber o detector recupera el flujo.
8. Una deteccion visible en el cliente referencia evidencia del mismo frame.
9. El cliente no puede solicitar playback, eventos o evidencia de otro tenant.
10. No hay claves, tokens o passwords reales versionados.

## Preguntas para revisar con producto

- Que eventos justifican guardar imagen y cuales requieren clip pre/post evento.
- Cuantas camaras y que resolucion/codecs tendra el primer piloto.
- Cual es la latencia maxima aceptable por caso de uso.
- Si se requiere playback continuo, investigacion historica o ambos.
- Retencion, privacidad y consentimiento requeridos por tenant.
- Que ocurre cuando el sitio pierde internet durante minutos u horas.
