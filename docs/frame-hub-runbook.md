# Frame Hub: Runbook Operativo

`frame-hub` es el hot path de deteccion de video: recibe un frame por camara,
descarta cambios irrelevantes con MOG2, conserva evidencia de los triggers y
ejecuta los pipelines configurados para esa camara. Publica un unico
`detection.batch` por `{cameraId, pts}` y eventos semanticos derivados.

## Flujo

```text
RTSP -> frame-grabber -> frame-hub (motion gate) -> inference-bridge -> GPU nodes
                              |                                      |
                              +-> evidence TTL                         +-> detection.batch
```

El capturador usa `CAP_PROP_POS_MSEC` como PTS cuando el stream lo expone. Para
camaras RTSP que no lo hacen, utiliza un fallback en milisegundos y mantiene el
mismo identificador en todos los resultados del frame.

## Variables de despliegue

En el `frame-grabber`:

```env
FRAME_HUB_URL=http://frame-hub:8100/v1/frames
FPS=2
```

En el `frame-hub`:

```env
INFERENCE_BRIDGE_URL=http://inference-bridge:8090
EVENT_GATEWAY_URL=http://event-gateway:3011
EVENT_PUBLISH_SECRET=...
FRAME_HUB_DEFAULT_MODEL_REF=yolo11n@1.0
FRAME_HUB_MOTION_WIDTH=320
FRAME_HUB_MOTION_THRESHOLD=0.025
FRAME_HUB_MOTION_WARMUP_FRAMES=20
FRAME_HUB_MAX_CONCURRENT_PIPELINES=8
FRAME_HUB_MAX_INFLIGHT_PER_PIPELINE=1
FRAME_HUB_FRAME_TTL_SECONDS=120
```

Para usar la politica persistida en `CameraProfile` se requiere un token de
servicio con acceso de lectura a la camara:

```env
FRAME_HUB_PROFILE_API_URL=http://api:3001
FRAME_HUB_PROFILE_API_TOKEN=...
FRAME_HUB_PROFILE_CACHE_SECONDS=30
```

Sin token, usar `FRAME_HUB_CAMERA_PROFILES_JSON` por despliegue o se aplica un
pipeline YOLO rapido por defecto.

## Politicas

Los pipelines de `CameraProfile.detectionProfile.pipelines` se ejecutan en
paralelo despues del gate. Cada pipeline debe especificar el `modelRef` dentro
de `thresholds` si no usa el default global.

```json
{
  "pipelines": [
    {
      "pipelineId": "entrada-personas",
      "provider": "yolo",
      "taskType": "object_detection",
      "quality": "fast",
      "enabled": true,
      "schedule": { "mode": "realtime", "frameStride": 1 },
      "thresholds": { "modelRef": "yolo11n@1.0", "confidence": 0.35, "maxDet": 12 }
    }
  ]
}
```

Las reglas temporales viven en `CameraProfile.rulesProfile`:

```json
{
  "semantic": {
    "dwellSeconds": { "dog": 120, "person": 90 },
    "personLoiteringSeconds": 45
  }
}
```

El tracker del Hub mantiene tracks por etiqueta e IoU. Esto produce
`presence.dwell` y `person.loitering` una sola vez por track. No debe usarse
para identidad: rostro, patente y clasificacion de objeto persistente deben ser
pipelines especializados que se escalan desde la deteccion general.

## Escalamiento por ROI

Los detectores caros se declaran como dependientes en `outputs`. El Hub espera
el detector padre, filtra por clase y confianza, y entrega al hijo solamente el
crop del objeto calificado. Esto evita ejecutar OCR o embedding sobre el frame
completo.

```json
{
  "pipelines": [
    {
      "pipelineId": "objects",
      "provider": "yolo",
      "taskType": "object_detection",
      "enabled": true,
      "thresholds": { "modelRef": "yolo11n@1.0" }
    },
    {
      "pipelineId": "driveway-lpr",
      "provider": "lpr",
      "taskType": "license_plate_detection",
      "enabled": true,
      "outputs": {
        "dependsOn": "objects",
        "gateLabels": ["car", "truck", "bus", "motorcycle"],
        "minConfidence": 0.6,
        "cropFromParent": true,
        "cropPaddingRatio": 0.1
      },
      "thresholds": { "modelRef": "plate-detector@1.0" }
    }
  ]
}
```

La misma forma aplica a una entrada: `gateLabels: ["person"]` y un pipeline
facial como hijo. El repositorio todavia no tiene un nodo local GPU de cara con
embeddings ni uno LPR/OCR registrado; declarar estas politicas antes de
desplegarlos generara un run con error de capacidad, no una deteccion ficticia.

## Operacion

`GET /health` muestra frames recibidos, triggers, skips, runs y evidencia
retenida. `GET /v1/runs?cameraId=<id>` permite inspeccionar los ultimos runs.
La evidencia activa se sirve en `GET /v1/frames/{cameraId}/{pts}.jpg`.

Para Coolify, desplegar el `frame-hub` junto al bridge/control plane y los nodos
TensorRT en el host GPU. El volumen `/data/frames` es efimero y debe tener TTL;
no usarlo como archivo de video.

## Mocks por Raspberry Pi

El compose `infra/docker-compose.rpi-sim.yml` publica un archivo seleccionado
desde el volumen externo `nearhome-mock-videos`. Cada instancia puede usar una
subred, puerto, tenant y escenario propios:

```bash
RPI_STACK_NAME=nearhome-rpi-entrada \
RPI_SIM_SUBNET=10.98.1.0/24 RPI_SIM_GATEWAY=10.98.1.1 \
RPI_CAMERA_IP=10.98.1.10 RPI_GENERATOR_IP=10.98.1.11 RPI_SIM_IP=10.98.1.2 \
RPI_RTSP_HOST_PORT=18554 RPI_ID=rpi-entrada TENANT_ID=tenant-a \
MOCK_VIDEO_FILE=office-entrance.mp4 \
docker compose -f infra/docker-compose.rpi-sim.yml up -d
```

Los escenarios generados por `scripts/pilot/generate-cctv-videos.py` incluyen
`office-entrance`, `parking-lot`, `street-crossing`, `corridor` y
`loading-dock`, con un JSON de ground truth por video. Para cargar assets en el
host GPU, copiar los MP4 y JSON al volumen `nearhome-mock-videos` antes de
levantar el simulador.
