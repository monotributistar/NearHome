# Edge Node Product - TASKS

## Estado inicial verificado

- [x] Existe agente de discovery y heartbeat.
- [x] Existe router WireGuard en contenedor.
- [x] Existe API de edge gateways y pruebas de lifecycle.
- [x] Existe compose de detector para Linux box.
- [ ] El simulador RPi valida con Docker Compose.
- [x] Las rutas de dispositivo aplican autenticacion.
- [x] El baseline edge vigente esta verde con schema de test actualizado.
- [ ] Existe una unica ruta canonica de inferencia.
- [ ] Existe prueba real en Raspberry Pi y RTX 3070.

## Fase 0 - Seguridad y baseline reproducible

- [x] Eliminar del repositorio claves WireGuard, passwords y JWT reales.
- [ ] Rotar la clave WireGuard en cualquier host donde haya sido instalada.
- [x] Aplicar `deviceAuthPreHandler` a heartbeat, camera discovery y device discovery.
- [x] Derivar tenant del gateway autenticado.
- [x] Actualizar/resetear DB de test y dejar verde el baseline edge vigente.
- [x] Separar las suites que dependen del contrato VPN legacy archivado.
- [x] Corregir parser `/proc/net/arp` y sus fixtures.
- [x] Documentar `.env.example` sin secretos.

**Gate:** `git diff --check`, tests edge y compose config pasan desde checkout limpio.

## Fase 1 - Dos edges simulados

- [ ] Reemplazar `docker-compose.rpi-sim.yml` por un generador parametrico.
- [ ] Declarar volumen/config de MediaMTX correctamente.
- [ ] Persistir keypairs WireGuard y estado de control VPN.
- [ ] Registrar cada simulador y guardar su token.
- [ ] Usar endpoints `/api/v1/edge-gateways/{id}/...`.
- [ ] Crear dos LAN no superpuestas y dos camaras de prueba.
- [ ] Probar hub->camera para ambos tenants.
- [ ] Probar edge-A -X-> edge-B y acceso API con token cruzado.
- [ ] Agregar cleanup idempotente.

**Gate:** harness repetible de dos tenants, incluyendo pruebas negativas.

## Fase 2 - Media ingress canonico

- [ ] Seleccionar FFmpeg/GStreamer como captura productiva.
- [ ] Implementar `frameId`, PTS, `capturedAt` y dimensiones.
- [ ] Implementar cola latest-frame acotada por camara.
- [ ] Separar lectura RTSP de dispatch a inferencia.
- [ ] Agregar reconexion con backoff/jitter y timeouts.
- [ ] Evitar doble transcode entre HLS e inferencia.
- [ ] Exponer metricas de input FPS, sampled FPS, drops y reconnects.

**Gate:** cuatro streams durante 8 horas sin backlog ni crecimiento de memoria.

## Fase 3 - RTX 3070

- [ ] Corregir VRAM declarada a la capacidad real detectada por `nvidia-smi`.
- [ ] Elegir `inference-node-tensorrt` como YOLO canonico.
- [ ] Construir engine YOLO11n FP16 en la Linux box.
- [ ] Implementar readiness y warmup.
- [ ] Conectar frame pipeline mediante inference-bridge.
- [ ] Deprecar `detector:8000` para el camino nuevo.
- [ ] Benchmark 1/4/8/12 camaras a 1, 2 y 5 FPS.
- [ ] Registrar p50/p95/p99 de queue, decode, inference y end-to-end.
- [ ] Ajustar concurrencia y batch solo con evidencia del benchmark.

**Gate:** cuatro camaras a 1 FPS, p95 deteccion <1.5 s y GPU estable por 8 horas.

## Fase 4 - Storage y clientes

- [ ] Agregar MinIO/S3 para evidencia.
- [ ] Definir policy de snapshot y clip por tipo de evento.
- [ ] Implementar TTL y lifecycle.
- [ ] Reemplazar acceso Caddy a `/frames` por URLs firmadas.
- [ ] Eliminar IDs de usuario/tenant hardcodeados del detector y API interna.
- [ ] Persistir metadata idempotente por `frameId` y detector.
- [ ] Autenticar SSE y playback HLS por tenant/camera.
- [ ] Correlacionar overlay con `frameId` y dimensiones.

**Gate:** evento, evidencia y playback funcionan sin fuga cross-tenant.

## Fase 5 - Raspberry Pi real

- [ ] Preparar Raspberry Pi OS Lite 64-bit con Docker.
- [ ] Desplegar los mismos servicios y volumenes del simulador.
- [ ] Validar Ethernet para camaras y salida WAN separada cuando aplique.
- [ ] Probar SNAT y route mode.
- [ ] Ejecutar corte de internet, reboot, power loss y rotacion de claves.
- [ ] Ejecutar soak de 24 horas con una camara real.
- [ ] Dejar runbook de provision, diagnostico y decommission.

**Gate:** flujo completo real y recuperacion automatica demostrados.

## Fase 6 - BalenaOS y piloto

- [ ] Portar compose validado a Balena multi-container.
- [ ] Verificar persistencia de identidades entre releases.
- [ ] Verificar OTA con rollback.
- [ ] Comparar operacion BalenaCloud, openBalena y Docker directo.
- [ ] Seleccionar plataforma con criterios de costo, OTA y soporte.
- [ ] Ejecutar acceptance de 24 horas con carga objetivo del piloto.

## Orden inmediato recomendado

1. Fase 0 completa.
2. Fase 1 con dos simuladores.
3. Fase 3 minima en paralelo con Fase 2.
4. Revisar casos de uso y fijar camaras, codecs, FPS, retencion y latencia.
5. Fases 4 y 5 para cerrar producto funcional.
