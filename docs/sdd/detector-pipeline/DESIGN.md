# Detector Pipeline — DESIGN

## Architecture Overview

```
RTSP Stream
    │
    ▼
[frame-grabber]                    ← captura frame + PTS real
    │
    │ POST /api/frames (multipart: image + cameraId + pts)
    ▼
┌──────────────────┐
│   Frame Hub      │              ← nuevo servicio (FastAPI)
│   :8100          │
│                  │
│  /frames/{camId}/│
│    {pts}.jpg     │              ← almacena y sirve frames
└──────┬───────────┘
       │
       │ (Pipeline Runner consulta CameraProfile.detectionProfile)
       ▼
┌─────────────────────┐
│  Pipeline Runner     │           ← nuevo módulo dentro de Frame Hub
│                      │
│  Lee policy de cámara│
│  Orquesta pasos:     │
│  [yolo, license]     │
│  [mediapipe]         │
│  [none]              │
└────┬──────────┬──────┘
     │          │
     ▼          ▼
┌─────────┐ ┌──────────────┐
│ yolo    │ │ license-plate│        ← detectores independientes
│ node    │ │ node         │
│ :8091   │ │ :8093        │
└────┬────┘ └──────┬───────┘
     │             │
     └──────┬──────┘
            │ (resultados con mismo PTS)
            ▼
┌──────────────────┐
│  Result Merger   │               ← nuevo módulo en Frame Hub
│                  │
│  Agrupa por PTS  │
│  + latency stats │
└──────┬───────────┘
       │
       │ POST /internal/events/publish (detection.batch)
       ▼
┌──────────────────┐
│  Event Gateway   │
│  :3011           │
└──────┬───────────┘
       │
       ▼
  Browser (SSE)
```

## Componentes

### 1. Frame Hub (nuevo — FastAPI :8100)

Recibe frames del frame-grabber, los almacena indexados por `{cameraId}/{pts}.jpg`, y los sirve bajo demanda a los detectores.

**Endpoints:**

```
POST /api/frames
  Body: multipart (image + cameraId + pts + width + height + tenantId)
  Response: { ok: true, frameUrl: "/frames/{camId}/{pts}.jpg" }
  ─ Almacena el frame en disco + metadata en memoria
  ─ Dispara el Pipeline Runner para este frame

GET /api/frames/{camId}/{pts}.jpg
  Response: image/jpeg
  ─ Sirve el frame estático

GET /api/frames/{camId}/latest
  Response: { pts, frameUrl, capturedAt }
  ─ Devuelve el PTS del frame más reciente de esa cámara

GET /health
  Response: { metrics: { totalFrames, framesByCamera: {...}, totalPipelines, ... } }
```

**Almacenamiento:**
- Frames en disco: `/data/frames/{cameraId}/{pts}.jpg`
- Metadata en memoria (LRU con max frames por cámara, default 100)
- TTL de frames: configurable (default 60s). Los frames viejos se limpian periódicamente

### 2. Camera Policy (extensión de CameraProfile existente)

Se reactiva el campo `CameraProfile.detectionProfile` con este schema:

```json
{
  "version": 1,
  "steps": [
    {
      "id": "yolo-detection",
      "detector": "yolo",
      "runtime": "onnx",           // "onnx" | "pytorch"
      "params": {
        "model": "yolo11n.onnx",
        "conf": 0.25,
        "max_det": 10,
        "resolution": 640
      },
      "timeout_ms": 5000,
      "optional": false            // true = skip si falla, no detiene el pipeline
    },
    {
      "id": "license-plate",
      "detector": "license-plate",
      "depends_on": ["yolo-detection"],
      "depends_filter": {
        "labels": ["car", "truck", "bus", "motorcycle"],
        "min_confidence": 0.6
      },
      "params": {},
      "timeout_ms": 3000,
      "optional": true
    }
  ],
  "max_concurrent": 2,
  "frame_skip_threshold_ms": 800   // si un paso tarda más que esto, se saltean frames
}
```

**API endpoints para CameraProfile:**

```
PATCH /api/cameras/{id}/profile
  Body: { detectionProfile: { ... } }

GET /api/cameras/{id}/profile
  Response: { detectionProfile, detectorConfigKey, ... }
```

**Temporal:** El campo `tags` de Camera se deja como está para compatibilidad. La source of truth pasa a ser `CameraProfile.detectionProfile`. El tag `detector:yolo` sigue funcionando como default si no hay profile.

### 3. Pipeline Runner (dentro de Frame Hub)

Módulo interno que:

1. **Al recibir un frame:**
   - Consulta `CameraProfile.detectionProfile` para esa cámara (cache 30s)
   - Si no hay profile, usa default: `[{detector: "yolo", runtime: "onnx"}]`
   - Si el primer paso es `"none"`, no hace nada
   - Crea un `PipelineRun { runId, cameraId, pts, steps: [...], status: "running", startedAt }`

2. **Ejecuta cada paso:**
   - Si `depends_on` está vacío → corre en paralelo con otros pasos independientes
   - Si `depends_on` tiene referencias → espera a que esos pasos terminen
   - Si `depends_filter` está definido → solo corre si las detecciones del paso anterior matchean el filtro
   - Envía el frame al detector vía HTTP POST (multipart o JSON)
   - Mide latencyMs de cada paso
   - Si el detector no responde en `timeout_ms`, marca timeout

3. **Adaptive frame skip:**
   - Después de cada inferencia, calcula `stepLatency`.
   - Si `stepLatency > frame_skip_threshold_ms`:
     - Incrementa `skippedFrames` para ese paso
     - Saltea el próximo frame (no lo envía)
     - Cuando el detector reporta `queueDepth = 0` y `lastLatencyMs < threshold`, vuelve a enviar
   - Si un detector falla 3 veces consecutivas → lo marca como `degraded` y notifica via evento `detector.status`

4. **Timeout total del pipeline:**
   - `max_pipeline_ms = sum(steps.timeout_ms) + buffer`
   - Si se excede, los pasos pendientes se cancelan y el batch se publica con lo que se tenga

**Pseudocódigo:**

```python
async def run_pipeline(camera_id: str, pts: int, image_bytes: bytes):
    profile = get_camera_profile(camera_id)
    steps = profile.get("steps", [{"detector": "yolo", "runtime": "onnx"}])

    if steps[0]["detector"] == "none":
        return  # cámara deshabilitada

    results = {}
    latencies = {}

    # Fase 1: pasos independientes (sin depends_on)
    independents = [s for s in steps if not s.get("depends_on")]
    if independents:
        async with TaskGroup() as tg:
            for step in independents:
                tg.create_task(run_step(step, image_bytes, pts, results, latencies))

    # Fase 2: pasos dependientes (esperan resultados de fase 1)
    dependents = [s for s in steps if s.get("depends_on")]
    for step in dependents:
        # Verificar depends_filter contra results de pasos anteriores
        if not step_matches_filter(step, results):
            continue
        async with TaskGroup() as tg:
            tg.create_task(run_step(step, image_bytes, pts, results, latencies))

    # Merger
    batch = merge_results(pts, camera_id, results, latencies)
    await publish_batch(batch)
```

### 4. inference-node-yolo (mejorado)

Se agrega modo ONNX. El nodo existente se modifica para soportar ambos runtimes.

**Nuevas env vars:**

```
YOLO_RUNTIME=onnx           # "onnx" | "pytorch" (default: onnx)
YOLO_MODEL=yolo11n.onnx     # .onnx o .pt según runtime
```

**Nuevo endpoint:**

```
POST /v1/infer
  Multipart: image + optional: conf, max_det, runtime
  Response: {
    detections: [{label, classId, confidence, bbox}],
    latencyMs: 45,
    runtime: "onnx",
    nodeId: "node-yolo-1"
  }
```

**ONNX implementation:**

```python
import onnxruntime as ort

class YOLOONNX:
    def __init__(self, model_path: str):
        self.session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        # Metadata del modelo
        self.input_shape = self.session.get_inputs()[0].shape  # [1, 3, 640, 640]

    def infer(self, image: np.ndarray) -> List[Dict]:
        # Preprocess: resize + normalize
        resized = cv2.dnn.blobFromImage(image, 1/255.0, (640, 640), swapRB=True)
        # Run
        outputs = self.session.run(None, {self.input_name: resized})
        # Postprocess (NMS + decode)
        return self._postprocess(outputs)
```

**Health endpoint extendido:**

```json
GET /health
{
    "service": "inference-node-yolo",
    "nodeId": "node-yolo-1",
    "runtime": "onnx",
    "model": "yolo11n.onnx",
    "config": {"conf": 0.25, "max_det": 10, "resolution": 640},
    "metrics": {
        "totalInferences": 150,
        "avgLatencyMs": 12.3,
        "lastLatencyMs": 15,
        "errors": 0,
        "queueDepth": 0,
        "modelLoaded": true,
        "modelLoadTimeS": 0.8
    }
}
```

### 5. Result Merger (dentro de Frame Hub)

Agrupa resultados por `{cameraId, pts}`. Lógica:

```python
async def merge_results(pts: int, camera_id: str, step_results: dict, latencies: dict):
    """Agrupa todas las detecciones de un mismo PTS."""

    all_detections = []
    for step_id, detections in step_results.items():
        for d in detections:
            all_detections.append({
                "step": step_id,
                "label": d["label"],
                "confidence": d["confidence"],
                "bbox": d["bbox"],
                **d.get("extra", {})  # metadata específica del detector
            })

    batch = {
        "eventType": "detection.batch",
        "tenantId": cached_profile["tenantId"],
        "cameraId": camera_id,
        "occurredAt": datetime.now(timezone.utc).isoformat(),
        "payload": {
            "pts": pts,
            "frameUrl": f"/frames/{camera_id}/{pts}.jpg",
            "detections": all_detections,
            "totalDetections": len(all_detections),
            "latencyMs": latencies,
            "totalPipelineMs": sum(latencies.values()),
            "skippedFrames": skipped_frames.get(camera_id, {}),
        }
    }

    # Publicar en event-gateway
    await publish_to_event_gateway(batch)

    # Persistir en DB (batch de DetectionObservation)
    await store_to_db(batch)
```

**Formato del evento detection.batch:**

```json
{
    "eventType": "detection.batch",
    "tenantId": "tenant-a-oficinas",
    "cameraId": "cam-a-entrada",
    "occurredAt": "2026-06-21T13:30:00Z",
    "payload": {
        "pts": 1234567,
        "frameUrl": "/frames/cam-a-entrada/1234567.jpg",
        "frameWidth": 640,
        "frameHeight": 480,
        "detections": [
            {"step": "yolo-detection", "label": "person", "confidence": 0.89, "bbox": {"x": 100, "y": 200, "w": 50, "h": 120}},
            {"step": "yolo-detection", "label": "car", "confidence": 0.76, "bbox": {"x": 300, "y": 150, "w": 200, "h": 80}},
            {"step": "license-plate", "label": "plate", "confidence": 0.92, "bbox": {"x": 310, "y": 160, "w": 80, "h": 20}, "extra": {"plate": "AB123CD"}}
        ],
        "totalDetections": 3,
        "latencyMs": {"yolo-detection": 45, "license-plate": 120},
        "totalPipelineMs": 165,
        "timeouts": [],
        "skippedFrames": {"yolo-detection": 0, "license-plate": 0}
    }
}
```

### 6. Frame Grabber (modificado)

Cambios mínimos al frame-grabber existente:

1. **Extraer PTS real:**
   ```python
   pts = int(cap.get(cv2.CAP_PROP_POS_MSEC))  # PTS en milisegundos
   if pts == 0:
       pts = int(time.time() * 1000)  # fallback
   ```

2. **Enviar a Frame Hub en vez de a detector:8000**
   ```python
   # Antes: POST a detector:8000/detect
   # Ahora: POST a frame-hub:8100/api/frames
   body, boundary = _build_multipart({
       "cameraId": cam['id'],
       "tenantId": cam['tenant'],
       "pts": str(pts),
       "width": str(w),
       "height": str(h)
   }, img_bytes)

   req = Request("http://frame-hub:8100/api/frames", data=body, method="POST")
   ```

3. **Detector mode** se mantiene como tag para compatibilidad, pero ahora es el Frame Hub quien decide qué hacer según el `detectionProfile`

## Schema de Prisma (cambios)

No se agregan nuevos modelos. Se reutilizan los existentes:

- **CameraProfile.detectionProfile** — se escribe el JSON del pipeline
- **DetectionJob.mode** — ahora se usa como `pipeline_run_id` (el UUID del run)
- **DetectionObservation.frameTs** — se almacena como el PTS real (en ms desde epoch)
- **DetectionObservation.providerMeta** — se guarda `{"step": "yolo-detection", "runtime": "onnx", "pts": 1234567}`

## Plan de Implementación (5 fases)

### Fase 1 — Frame Hub con PTS real (día 1-2)

**Qué se entrega:**
- [ ] Servicio `apps/frame-hub/` (FastAPI)
- [ ] Endpoint POST /api/frames (recibe multipart + PTS)
- [ ] Almacenamiento en disco indexado por `{cameraId}/{pts}.jpg`
- [ ] GET /api/frames/{camId}/{pts}.jpg (sirve frames)
- [ ] Frame-grabber modificado para extraer PTS real y enviar a frame-hub
- [ ] Dockerfile + entrada en docker-compose.poc.yml
- [ ] Health endpoint con métricas

**Tests:** E2E: frame-grabber → frame-hub → frame almacenado → GET verifica integridad

### Fase 2 — Camera Policy (día 2-3)

**Qué se entrega:**
- [ ] API PATCH/GET /api/cameras/{id}/profile para detectionProfile
- [ ] Schema JSON de pipeline validado en backend
- [ ] Cache de policies en Frame Hub (30s TTL)
- [ ] Pipeline Runner: leer policy, detectar "none", detectar default

**Tests:** API: crear profile, leer profile, cámara sin profile usa default

### Fase 3 — Pipeline Runner + ONNX (día 3-5)

**Qué se entrega:**
- [ ] Módulo Pipeline Runner dentro de Frame Hub
- [ ] Ejecución de pasos independientes en paralelo (asyncio TaskGroup)
- [ ] Ejecución de pasos dependientes en serie con depends_filter
- [ ] inference-node-yolo con modo ONNX (YOLO_RUNTIME=onnx)
- [ ] Timeout por paso + manejo de errores
- [ ] Adaptive frame skip (basado en latency)
- [ ] Deprecar detector:8000 (no se elimina, no se usa en nuevos pipelines)

**Tests:** Pipeline 2 pasos independientes, pipeline con depends_on, pipeline con timeout, ONNX vs PyTorch speed comparison

### Fase 4 — Latency Tracking (día 4-5, paralelo con Fase 3)

**Qué se entrega:**
- [ ] Métricas de latencia por paso en /health de cada nodo
- [ ] Frame Hub recolecta latencias en cada pipeline run
- [ ] Pipeline Runner saltea frames basado en threshold
- [ ] Evento `detector.status` cuando un detector pasa a degraded/offline

**Tests:** Verificar que frame skip funciona cuando detector va lento

### Fase 5 — Result Merger + Evento detection.batch (día 5-6)

**Qué se entrega:**
- [ ] Módulo Result Merger en Frame Hub
- [ ] Merge de resultados por PTS
- [ ] Publicación de evento detection.batch en event-gateway
- [ ] Persistencia en DB (DetectionObservation batch)
- [ ] Frontend: DetectionOverlay adaptado para leer detection.batch
- [ ] Cleanup periódico de frames viejos (60s TTL)

**Tests:** E2E: frame → 2 detectores → merge → evento SSE → overlay en browser

## Trade-offs y decisiones

### Frame Hub como servicio separado vs módulo dentro de inference-bridge

**Decisión:** Servicio separado (`apps/frame-hub/`).

**Razón:** El frame hub tiene un lifecycle distinto al inference-bridge (manejo de frames en disco, cache, cleanup). Mantenerlos separados permite escalar independientemente y no acoplar el control plane (bridge) con el data plane de frames.

### ONNX vs TensorRT

**Decisión:** ONNX primero. TensorRT post-MVP.

**Razón:** ONNX funciona en CPU y GPU sin cambios de código. TensorRT requiere NVIDIA GPU y es más complejo de configurar. ONNX ya da 3-5x sobre PyTorch, suficiente para el POC.

### Python vs Node.js para Frame Hub

**Decisión:** Python (FastAPI).

**Razón:** Los detectores existentes (YOLO, MediaPipe) ya están en Python. El frame hub necesita procesar imágenes, y Python + OpenCV es más natural. La consistencia con el monorepo Node.js se sacrifica aquí por pragmatismo técnico. El frame hub es un servicio acotado que no necesita compartir tipos con el frontend.

### detection.batch evento único vs múltiples detection.object

**Decisión:** Un solo evento `detection.batch` por frame con todas las detecciones.

**Razón:** El frontend necesita todas las detecciones de un frame para renderizar el overlay. Con eventos individuales, el frontend tendría que agrupar por PTS del lado del cliente, lo que es más complejo y propenso a race conditions. El batch ya viene agrupado.

## Referencias

- `CameraProfile.detectionProfile` — schema en prisma/schema.prisma línea 345
- `DetectionObservation.frameTs` — campo existente, se reutiliza para PTS
- `inference-node-yolo/app.py` — nodo existente a modificar para ONNX
- `frame-grabber/frame-grabber.py` — a modificar para PTS + frame-hub
- `infra/docker-compose.poc.yml` — agregar frame-hub service
- `infra/Caddyfile` — agregar ruteo /frames/* hacia frame-hub
