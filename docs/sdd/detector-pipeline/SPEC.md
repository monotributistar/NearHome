# Detector Pipeline — SPEC

## Why: Problema

El ecosistema de detectores de NearHome hoy tiene **dos caminos paralelos** que hacen lo mismo sin coordinarse:

```
frame-grabber → detector:8000 (legacy YOLO app)
             → inference-node-yolo:8091 (nodo registrado en bridge)
             → HF Spaces (yolo-detector, face-embedder)
```

**Problemas concretos:**

1. **Duplicación**: `detector:8000` e `inference-node-yolo` corren YOLO por separado, cada uno con su propio modelo y configuración
2. **Pipelines rígidos**: cada cámara tiene un solo modo (`detector:yolo` o `detector:mediapipe` en tags), no puede correr múltiples detectores en cadena (ej: YOLO → license-plate → face-recognition)
3. **Sin PTS real**: los frames se identifican por `datetime.utcnow()` cuando se capturan, no por el PTS del stream de video. Si dos detectores procesan el mismo frame a distinta velocidad, no hay forma de correlacionarlos
4. **Sin métricas de velocidad**: no se registra cuánto tarda cada detector, ni se usa esa info para decidir si saltear frames
5. **CameraProfile infrautilizado**: el modelo `CameraProfile` ya tiene campos `detectionProfile`, `detectorConfigKey`, `detectorFlags` pero no se usan — la configuración real está hardcodeada en env vars del docker-compose

## What: Alcance

Construir un **sistema de pipelines de detección por cámara** donde:

1. Cada cámara define su pipeline (secuencia de detectores a aplicar)
2. Los detectores son servicios independientes que se pueden iniciar/detener por cámara
3. Todos los detectores referencian el mismo frame (identificado por PTS real del stream)
4. Se registra latencia por detector para decidir si escalar o saltear frames
5. Los resultados se mergean por PTS para tener una vista unificada por frame

### In scope (features que entran)

| Feature | Descripción |
|---------|-------------|
| Frame Hub | Servicio central que recibe frames del frame-grabber, los indexa por `{cameraId}/{pts}.jpg` y los sirve a los detectores |
| PTS tracking | El frame-grabber extrae PTS real via `cv2.CAP_PROP_POS_MSEC` y lo usa como identificador |
| Camera Policy | Schema JSON en `CameraProfile.detectionProfile` con `{steps: [{detector, params}]}` |
| Detector unificado | Deprecar `detector:8000`. Unificar todo el YOLO en `inference-node-yolo` con modo ONNX para speed |
| ONNX Runtime | Agregar inferencia via ONNX (usando el `yolo11n.onnx` existente) que es 3-5x más rápido que PyTorch |
| Pipeline Runner | Orquestador que lee la policy de la cámara y ejecuta los pasos en serie/paralelo |
| Latency tracking | Cada detector reporta latencyMs, queueDepth, fpsEfectivo |
| Adaptive frame skip | Si un detector va lento (> intervalo de captura), se saltean frames automáticamente |
| Result Merger | Agrupa detecciones de múltiples detectores para un mismo PTS en un solo DetectionObservation batch |

### Out of scope (no entra)

- Face recognition pipeline (ya existe face-embedder, se integra como un detector más en el futuro)
- Grabación de video / archivo persistente
- Dashboard de métricas de detectores
- Auto-scaling de nodos (por ahora es manual via docker-compose)

## Who: Actors

- **Camera** — tiene un `detectionProfile` que define su pipeline
- **Frame Hub** — recibe frames, los almacena indexados por PTS, y los sirve bajo demanda
- **Pipeline Runner** — lee la policy de la cámara y orquesta los pasos
- **Detector Node** — servicio independiente que recibe una imagen y devuelve detecciones (YOLO, MediaPipe, license-plate, etc.)
- **Result Merger** — recibe resultados de múltiples detectores y los agrupa por PTS
- **Event Gateway** — recibe los resultados mergeados y los publica como eventos SSE

## User Stories con Acceptance Criteria

### US-01: Camera Policy — Pipeline configurable por cámara

**Como** administrador del sistema
**Quiero** poder configurar qué detectores se aplican a cada cámara y en qué orden
**Para** que cada cámara tenga el pipeline adecuado a su escenario (ej: entrada con face, calle con YOLO+placa)

```
SCENARIO: Configurar pipeline de cámara via API
  GIVEN una cámara "cam-a-entrada" existe
  WHEN hago PATCH /api/cameras/cam-a-entrada/profile con:
    { "detectionProfile": "{\"steps\":[{\"detector\":\"yolo-v8n\",\"params\":{\"conf\":0.25,\"max_det\":10}},{\"detector\":\"license-plate\",\"depends_on\":\"yolo-v8n\",\"filter\":{\"label\":\"car\"}}]}" }
  THEN el profile se guarda en CameraProfile.detectionProfile
  AND el Pipeline Runner lee la nueva policy en ≤30s

SCENARIO: Cámara sin policy usa default
  GIVEN una cámara sin detectionProfile configurado
  WHEN el Pipeline Runner procesa un frame de esa cámara
  THEN aplica el pipeline default: [yolo-v8n]
```

### US-02: Frame Hub — Frames identificados por PTS real

**Como** detector node
**Quiero** recibir frames identificados por el PTS (Presentation Timestamp) del stream de video, no por un timestamp arbitrario
**Para** poder correlacionar mis resultados con los de otros detectores sobre el mismo frame

```
SCENARIO: Frame es capturado con PTS real
  GIVEN la cámara "cam-a-entrada" tiene stream RTSP activo
  WHEN el frame-grabber captura un frame
  THEN el frame se almacena como /frames/cam-a-entrada/{pts}.jpg
  AND el PTS es el valor real de cv2.CAP_PROP_POS_MSEC
  AND el evento incluye { cameraId, pts, width, height, frameUrl }

SCENARIO: Dos detectores ven el mismo frame
  GIVEN el Frame Hub recibe un frame con PTS=1234567 de cam-a-entrada
  WHEN el pipeline runner envía el frame a yolo-node y a license-node
  THEN ambos detectores reciben el mismo frameUrl /frames/cam-a-entrada/1234567.jpg
  AND ambos resultados incluyen el mismo PTS=1234567 en su respuesta
```

### US-03: Pipeline Runner — Orquestación de detectores

**Como** Pipeline Runner
**Quiero** ejecutar los pasos del pipeline según la policy de la cámara, respetando dependencias entre pasos
**Para** que detectores independientes corran en paralelo y detectores dependientes corran en serie

```
SCENARIO: Pasos independientes corren en paralelo
  GIVEN el detectionProfile de la cámara tiene:
    steps: [{detector: "yolo-v8n"}, {detector: "mediapipe-pose"}]
  WHEN el Pipeline Runner recibe un frame
  THEN envía el frame a yolo-node y mediapipe-node simultáneamente
  AND espera ambos resultados antes de continuar

SCENARIO: Pasos con depends_on corren en serie
  GIVEN el detectionProfile tiene:
    steps: [{detector: "yolo-v8n"}, {detector: "license-plate", depends_on: "yolo-v8n", filter: {label: "car"}}]
  WHEN el Pipeline Runner recibe un frame
  THEN primero ejecuta yolo-v8n
  AND si hay detecciones de "car" con confianza ≥ filter, recién ahí ejecuta license-plate
  AND si no hay "car", skipea license-plate

SCENARIO: Detector configurado como "none" se saltea
  GIVEN el detectionProfile tiene:
    steps: [{detector: "none"}]
  WHEN el Pipeline Runner recibe un frame
  THEN no ejecuta ningún detector
  AND no se genera ningún evento
```

### US-04: Latency Tracking — Métricas por detector

**Como** operador del sistema
**Quiero** ver cuánto tarda cada detector en procesar un frame y cuántos frames tiene en cola
**Para** saber si un detector está saturado y necesita escalar

```
SCENARIO: Detector reporta métricas en /health
  GIVEN inference-node-yolo está corriendo
  WHEN hago GET /health en el nodo
  THEN recibo:
    { "metrics": {
        "totalInferences": 150,
        "avgLatencyMs": 45.2,
        "lastLatencyMs": 52,
        "queueDepth": 0,
        "model": "yolo11n.onnx",
        "runtime": "onnx"
    }}

SCENARIO: Pipeline Runner saltea frames si detector va lento
  GIVEN el frame-grabber captura a 2 FPS (500ms entre frames)
  AND inference-node-yolo tiene avgLatencyMs de 1200ms
  WHEN el Pipeline Runner recibe un nuevo frame
  THEN detecta que el detector aún está ocupado con el frame anterior
  AND saltea el frame actual (no lo envía al detector)
  AND registra "frame skipped: detector busy" en el log
```

### US-05: Result Merger — Detecciones agrupadas por PTS

**Como** sistema de eventos
**Quiero** recibir un solo evento por frame que contenga TODAS las detecciones de todos los detectores
**Para** que el frontend pueda renderizar todas las detecciones de un frame de una sola vez

```
SCENARIO: Múltiples detectores producen resultados para el mismo PTS
  GIVEN yolo-node detectó ["person", "car"] en PTS=1234567
  AND mediapipe-node detectó ["pose_standing"] en el mismo PTS=1234567
  WHEN el Result Merger recibe ambos resultados
  THEN produce un solo evento detection.batch con:
    { "cameraId": "cam-a-entrada",
      "pts": 1234567,
      "frameUrl": "/frames/cam-a-entrada/1234567.jpg",
      "detections": [
        {"step": "yolo-v8n", "label": "person", ...},
        {"step": "yolo-v8n", "label": "car", ...},
        {"step": "mediapipe", "label": "pose_standing", ...}
      ],
      "latencyMs": {"yolo-v8n": 45, "mediapipe": 120}
    }
  AND el evento se publica en event-gateway como detection.batch

SCENARIO: Resultados fuera de tiempo se descartan
  GIVEN el Pipeline Runner tiene un timeout de 5s por paso
  WHEN license-plate no responde en 5s
  THEN el paso se marca como "timeout"
  AND el Result Merger produce el batch con los resultados que sí llegaron
  AND el evento incluye "timeouts": ["license-plate"] en metadata
```

## Acceptance Criteria (globales)

1. [ ] Una cámara puede configurarse con un pipeline de 0 a N detectores via API
2. [ ] El frame-grabber extrae PTS real del stream y lo pasa como identificador
3. [ ] Los frames se almacenan con ruta `/{cameraId}/{pts}.jpg`
4. [ ] El Pipeline Runner ejecuta pasos independientes en paralelo y dependientes en serie
5. [ ] Si un detector no puede seguir el ritmo, se saltean frames automáticamente
6. [ ] Cada detector expone métricas de latencia en /health
7. [ ] El Result Merger agrupa detecciones de múltiples detectores por PTS
8. [ ] Se publica un solo evento detection.batch por frame con todas las detecciones
9. [ ] ONNX Runtime disponible como alternativa a PyTorch para YOLO (3-5x speedup)
10. [ ] El detector legacy `detector:8000` queda deprecado (sigue funcionando, no se usa en nuevos pipelines)
11. [ ] inference-node-yolo puede alternar entre PyTorch y ONNX via env var YOLO_RUNTIME
12. [ ] CameraProfile.detectionProfile se escribe y lee correctamente via API REST

## Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| ONNX no funciona en ARM64 (macOS M4) | Media | Alto | PyTorch sigue disponible como fallback vía YOLO_RUNTIME=pytorch |
| PTS no disponible en algunos streams | Baja | Medio | Fallback a timestamp UTC si CAP_PROP_POS_MSEC devuelve 0 |
| Detector lento atasca el pipeline completo | Media | Alto | Timeout de 5s por paso + frame skip automático |
| Cambiar detectionProfile en caliente causa inconsistencias | Baja | Medio | Pipeline Runner cachea policy por 30s. El cambio se aplica en el próximo ciclo de refresh |
| Muchos detectores en paralelo saturan CPU/GPU | Alta | Alto | Limitar a `MAX_CONCURRENT_PIPELINES` (default 2) por host. Configurable por deployment |
