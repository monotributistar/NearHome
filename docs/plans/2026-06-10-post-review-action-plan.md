# NearHome — Plan de Acción Post-Revisión de Arquitectura

> **Para Hermes:** Usar `subagent-driven-development` para implementar task por task.
> **Análisis base:** Revisión en profundidad de 6 dimensiones (2026-06-10).

**Goal:** Convertir NearHome de "POC técnico con sobre-ingeniería" a "POC demostrable a cliente" en 2 semanas, podando lo innecesario y cerrando gaps críticos.

**Principio rector:** Si no se puede demonstrar en vivo con un cliente, no se construye ahora.

---

## Fase 0: Podar (1 día) — Eliminar sobre-ingeniería

> **Objetivo:** Reducir superficie de bugs y mantenimiento. Menos código = menos cosas que fallan en la demo.

### Task 0.1: Archivar modelos de face recognition

**Archivos a tocar:**
- `apps/api/prisma/schema.prisma` — comentar modelos `FaceDetection`, `FaceEmbedding`, `FaceCluster`, `FaceClusterMember`, `FaceIdentity`, `FaceIdentityMember`, `FaceIdentityMergeLog` (líneas ~600-700)
- `apps/api/src/domains/` — comentar rutas de face si existen
- `apps/admin/src/pages/` — comentar páginas de face cases

**Verificación:** `prisma generate` sin errores. API sigue funcionando.

```bash
pnpm --filter @app/api db:reset && curl http://localhost:3001/health | jq .ok
```

### Task 0.2: Archivar FleetGroup + DeploymentRollout

**Archivos a tocar:**
- `apps/api/prisma/schema.prisma` — comentar modelos `FleetGroup`, `DeploymentManifest`, `DeploymentRollout` (líneas ~934-988)
- `apps/api/src/domains/deployments/routes.ts` — comentar rutas
- `apps/admin/src/pages/deployments/` — comentar páginas

**Verificación:** `prisma generate` sin errores. Edge gateway register sigue funcionando.

### Task 0.3: Archivar Households + SubscriptionRequest

**Archivos a tocar:**
- `apps/api/prisma/schema.prisma` — comentar `Household`, `HouseholdMember`, `SubscriptionRequest`
- `apps/api/src/domains/households/routes.ts` — comentar
- `apps/api/src/domains/subscriptions/routes.ts` — comentar
- `apps/portal/src/pages/plan/` — comentar

**Verificación:** Portal carga sin errores 404 en páginas de plan/households.

### Task 0.4: Simplificar TenantVpn

**Archivos a tocar:**
- `apps/api/prisma/schema.prisma` — en `TenantVpn`, eliminar campos `topology`, `tunnelInterface`, `credentialsRef`. Dejar: `id, tenantId, name, provider, status, createdAt, updatedAt`
- `apps/api/src/domains/edge-gateways/routes.ts` — simplificar creación de VPN

**Verificación:** `POST /tenants/:id/vpns` con body `{ name: "site-1", provider: "wireguard" }` funciona.

### Task 0.5: Simplificar docker-compose

**Archivos a tocar:**
- Consolidar `infra/docker-compose.yml` + `infra/docker-compose.local.yml` en un solo archivo `infra/docker-compose.poc.yml`
- Eliminar: `docker-compose.onprem.yml`, `docker-compose.onprem.vault-remote.yml`, `docker-compose.postgres-staging.yml`, `docker-compose.detection.generated.yml`
- Mover a `infra/archive/`

**Verificación:** `docker compose -f infra/docker-compose.poc.yml up -d` levanta API + stream + event + bridge + redis + temporal.

---

## Fase 1: Cerrar gaps críticos (4 días) — Lo que falta para demo

### Task 1.1: Smoke test detección end-to-end

**Objetivo:** Validar el ciclo completo: frame → detección → incidente → notificación.

**Archivos:**
- Crear: `scripts/pilot/smoke-detection-e2e.sh`
- Modificar: `apps/api/src/domains/detection/service.ts` (agregar log de tracing)

**Flujo a validar:**
1. Frame sintético con persona → `POST /v1/infer/hf/yolo`
2. YOLO detecta "person" (confidence > 0.7)
3. API crea `DetectionJob` con status "completed"
4. `ScenePrimitiveEvent` creado con tipo `object_detected.person`
5. `IncidentEvent` creado con tipo `intrusion`, severity `high`
6. `NotificationDelivery` creado con channel `realtime`
7. Event gateway publica evento vía WS
8. Smoke test recibe evento en < 5 segundos

**Acceptance:** Script `smoke-detection-e2e.sh` pasa 3/3 ejecuciones.

### Task 1.2: STREAM_MEDIA_ENGINE=process con cámara real

**Objetivo:** Validar latencia real de ingesta RTSP → HLS.

**Archivos:**
- Modificar: `infra/docker-compose.poc.yml` — cambiar `STREAM_MEDIA_ENGINE=mock` a `process`
- Crear: `scripts/pilot/latency-bench.sh`

**Flujo:**
1. Conectar cámara RTSP real (o simulador ffmpeg con testsrc)
2. Medir: RTSP connect → primera frame en HLS playlist
3. Medir: frame rate, bitrate, packet loss
4. Documentar resultados en `docs/POC_LATENCY_REPORT.md`

**Acceptance:** Latencia < 2s para 640x480 15fps. Reporte documentado.

### Task 1.3: Portal detection overlay (bounding boxes)

**Objetivo:** Mostrar detecciones en vivo sobre el stream HLS en el Portal.

**Archivos:**
- Crear: `apps/portal/src/pages/realtime/DetectionOverlay.tsx`
- Crear: `packages/ui/src/hooks/useDetectionFeed.ts`
- Modificar: `apps/portal/src/pages/cameras/CameraDetailPage.tsx` — agregar toggle "Live Detection"

**Flujo:**
1. Usuario abre cámara en Portal
2. Activa toggle "Live Detection"
3. Portal captura frame del `<video>` vía canvas cada 500ms
4. Envía frame a `POST /v1/infer/hf/yolo`
5. Recibe detecciones → renderiza SVG overlay con bounding boxes
6. Muestra label + confidence sobre cada detección

**Acceptance:** Overlay visible sobre stream HLS. Bounding boxes correctamente posicionadas.

### Task 1.4: Reconexión RTSP con backoff

**Objetivo:** El stream-gateway debe reconectar automáticamente cuando una cámara se desconecta.

**Archivos:**
- Modificar: `apps/stream-gateway/src/app.ts` — en `runStreamProbe` (línea ~217), agregar lógica de reintento con backoff exponencial
- Crear: `apps/stream-gateway/test/reconnect.spec.ts`

**Lógica:**
```
Reintentos: 5 (configurable)
Backoff: 2s, 4s, 8s, 16s, 32s
Después de 5 fallos: status → "offline", publicar evento "camera.offline"
Al reconectar: status → "ready", publicar evento "camera.online"
```

**Acceptance:** Test simula desconexión → stream-gateway reconecta en < 10s.

### Task 1.5: Fix openBalena ARM64 o usar alternativa

**Objetivo:** Poder desplegar el edge gateway en Raspberry Pi físico.

**Opciones (elegir UNA):**

**Opción A (preferida):** Tailscale + systemd
- Instalar Tailscale en RPi y en el host NearHome
- systemd service que hace bridge RTSP: `socat TCP-LISTEN:8554,fork,reuseaddr TCP:<camera-ip>:554`
- Sin openBalena, sin Docker en el edge
- **Ventaja:** 30 min de setup, funciona en ARM64, sin dependencias pesadas

**Opción B:** openBalena en AMD64 VM
- Correr openBalena en una VM Linux x86_64 (UTM en Mac)
- Deployar RPi manualmente con balenaOS image
- **Ventaja:** mantiene el diseño original

**Archivos:**
- Si Opción A: crear `edge-gateway/tailscale/` con `setup.sh`, `rtsp-bridge.service`
- Si Opción B: crear `docs/OPENBALENA_AMD64_WORKAROUND.md`

**Acceptance:** Raspberry Pi físicamente streameando RTSP de una cámara local al stream-gateway.

---

## Fase 2: Demo-ready (2 días) — Pulido para cliente

### Task 2.1: Dashboard de eventos por tenant

**Archivos:**
- Crear: `apps/portal/src/pages/operations/DashboardPage.tsx`
- Modificar: `apps/portal/src/components/Layout.tsx` — agregar link

**Componentes:**
- Últimas 10 detecciones (tarjeta con cámara, tipo, timestamp)
- Conteo: detecciones hoy, incidentes abiertos, cámaras online
- Mini-gráfico: detecciones por hora (últimas 24h)

**Acceptance:** Dashboard carga en < 2s con datos reales del tenant.

### Task 2.2: Agregar modelo Site

**Archivos:**
- `apps/api/prisma/schema.prisma` — agregar modelo:
```prisma
model Site {
  id        String   @id @default(cuid())
  tenantId  String
  name      String
  address   String?
  createdAt DateTime @default(now())
  tenant    Tenant   @relation(fields: [tenantId], references: [id])
  edgeGateways EdgeGateway[]
  networkSpaces TenantNetworkSpace[]
  
  @@unique([tenantId, name])
}
```
- Agregar `siteId` opcional a `EdgeGateway` y `TenantNetworkSpace`
- `apps/api/src/domains/sites/routes.ts` — CRUD básico
- Migration: `prisma migrate dev --name add_site_model`

**Acceptance:** `POST /sites` crea un sitio. `GET /sites` lista por tenant. Edge gateway se asigna a sitio.

### Task 2.3: CI/CD con GitHub Actions

**Archivos:**
- Crear: `.github/workflows/ci.yml`

**Pipeline:**
```yaml
on: [push, pull_request]
jobs:
  test:
    - lint (eslint + prettier)
    - typecheck (turbo typecheck)
    - unit tests (vitest + pytest)
    - e2e smoke (pnpm test:e2e:portal:seeded)
  build:
    needs: test
    - docker build api, stream, event, bridge
```

**Acceptance:** PR merge en `main` ejecuta CI y pasa todos los tests.

---

## Fase 3: Post-POC (backlog) — No construir ahora

| Item | Razón para postergar |
|------|---------------------|
| Face recognition (7 modelos) | Proyecto separado, no necesario para demo de monitoreo |
| FleetGroup + DeploymentRollout | Solo útil con 10+ dispositivos |
| Households | Feature de app consumidor, no B2B |
| SubscriptionRequest con proofImage | Post-MVP |
| Storage multi-vault con failover | MinIO local alcanza para POC |
| ModelCatalogEntry | 2 modelos (YOLO, MediaPipe) no necesitan catálogo |
| Notification channels reales (Telegram, WhatsApp) | Webhook + email es suficiente para demo |

---

## Orden de ejecución

```
Día 1:  0.1 → 0.2 → 0.3 → 0.4 → 0.5 (podar)
Día 2:  1.1 (smoke e2e detección)
Día 3:  1.2 (media engine process) + 1.4 (reconexión RTSP)
Día 4:  1.3 (overlay detección) + 1.5 (edge en RPi)
Día 5:  2.1 (dashboard) + 2.2 (modelo Site)
Día 6:  2.3 (CI/CD) + documentación
Día 7:  Buffer — fixes, retests, ensayo de demo
```

---

## Estado actual vs target

| Dimensión | Hoy | Target POC |
|-----------|-----|------------|
| Modelos Prisma | 988 líneas, 40+ modelos | ~600 líneas, ~25 modelos |
| Docker Compose | 6 archivos | 1 archivo |
| Detección e2e | Piezas aisladas | Smoke test 3/3 |
| Stream RTSP | mock engine | process engine + reconexión |
| Portal | viewer sin detección | overlay bounding boxes |
| Edge en hardware | roto (ARM64) | Tailscale + RPi funcional |
| CI/CD | manual | GitHub Actions |
| Dashboard | no existe | eventos 24h + conteos |
| Modelo Site | no existe | CRUD + asignación |

---

## Notas para Hermes

- Cada task de la Fase 0 es independiente — se pueden ejecutar en paralelo.
- Task 1.1 depende de M2 (inference-bridge HF routes) ya implementado.
- Task 1.5: elegir Opción A (Tailscale) a menos que el usuario prefiera openBalena.
- Las Fases 1 y 2 son secuenciales dentro de cada una, pero Fase 1 y Fase 2 pueden overlap.
- Usar `delegate_task` con NVIDIA Nemotron para implementación (gratis). Si falla la API key, implementar directo con DeepSeek.
