# POC Detection Functional v1

Fecha: `2026-03-11`
Estado: `proposed`

## 1. Objetivo

Definir una POC funcional, operable y demostrable para cliente sobre el detection plane actual de NearHome.

El alcance v1 queda limitado a:

- proveedores soportados:
  - `yolo`
  - `mediapipe`
- tareas soportadas:
  - `person_detection`
  - `object_detection`
  - `license_plate_detection`
  - `face_detection`
  - `pose_estimation`
- calidades soportadas:
  - `fast`
  - `balanced`
  - `accurate`

La POC debe permitir:

- elegir proveedor, tarea y calidad por cámara
- exponer la configuración deseada y efectiva de nodos y perfiles
- desplegar nodos con configuración explícita
- consultar en tiempo real la configuración actualmente aplicada
- detectar caras
- almacenar crops y embeddings faciales
- agrupar caras de una misma persona
- consolidar grupos en una identidad lógica de persona

No forma parte de v1:

- reconocimiento biométrico cerrado contra padrón externo
- orquestación dinámica de infraestructura fuera de Docker Compose/Ansible
- autoscaling automático
- mTLS de nodo
- un nodo first-class de diff/change detection

## 2. Diagnóstico del estado actual

El proyecto ya tiene base operativa en:

- `NodeAuth`
- registro y heartbeat de nodos
- snapshots operativos de nodos
- dispatch async de jobs
- selección de nodo por `taskType` + `modelRef`

Limitaciones actuales:

- la creación de nodos en API genera snapshot + enrollment token, pero no despliega infraestructura
- la configuración de nodo vive dispersa entre Compose, envs del proceso y snapshot del bridge
- el contrato de detección usa `options` como JSON libre
- no existe un contrato explícito de `desired config` vs `observed config`
- no existe dominio persistente para identidad facial, clusters o merges

## 3. Principios de diseño

1. Separar operación de nodo de uso funcional por cámara.
2. Modelar calidad como concepto de negocio, no como `modelRef` libre en UI.
3. Mantener compatibilidad con el bridge actual y extenderlo en forma incremental.
4. Exponer siempre dos vistas:
   - configuración deseada
   - configuración efectiva observada
5. Hacer que la PoC sea vendible aunque la parte facial siga siendo asistida y no fully automatic.

## 4. Contratos nuevos

### 4.1 Model Catalog

Fuente única de verdad para modelos permitidos por el sistema.

Shape propuesto:

```json
{
  "provider": "yolo",
  "taskType": "face_detection",
  "quality": "balanced",
  "modelRef": "yolo26-face-s@1.0.0",
  "displayName": "YOLO Face Balanced",
  "resources": {
    "cpu": 4,
    "gpu": 0,
    "vramMb": 0
  },
  "defaults": {
    "minConfidence": 0.55,
    "nmsIoU": 0.45
  },
  "outputs": {
    "bbox": true,
    "keypoints": false,
    "embedding": false,
    "crop": true
  },
  "status": "active"
}
```

Reglas:

- UI elige `provider + taskType + quality`
- runtime resuelve internamente a `modelRef`
- `modelRef` queda como detalle técnico

### 4.2 Node Runtime Config

Representa la configuración deseada y efectiva de un nodo.

Shape propuesto:

```json
{
  "nodeId": "node-yolo-1",
  "desired": {
    "runtime": "yolo",
    "transport": "http",
    "endpoint": "http://inference-node-yolo:8091",
    "capabilities": [
      {
        "taskTypes": [
          "person_detection",
          "object_detection",
          "license_plate_detection",
          "face_detection"
        ],
        "qualities": ["fast", "balanced", "accurate"],
        "modelRefs": [
          "yolo26-person-n@1.0.0",
          "yolo26-person-s@1.0.0",
          "yolo26-face-s@1.0.0"
        ]
      }
    ],
    "resources": {
      "cpu": 8,
      "gpu": 1,
      "vramMb": 8192
    },
    "maxConcurrent": 4,
    "tenantIds": []
  },
  "observed": {
    "status": "online",
    "queueDepth": 0,
    "registeredAt": "ISO-8601",
    "lastHeartbeatAt": "ISO-8601",
    "capabilities": [],
    "resources": {}
  },
  "configVersion": 3,
  "lastAppliedAt": "ISO-8601"
}
```

### 4.3 Camera Detection Profile

Representa cómo usa una cámara el detection plane.

Shape propuesto:

```json
{
  "cameraId": "cam-001",
  "tenantId": "tenant-a",
  "pipelines": [
    {
      "pipelineId": "people-main",
      "provider": "yolo",
      "taskType": "person_detection",
      "quality": "balanced",
      "enabled": true,
      "schedule": {
        "mode": "realtime",
        "frameStride": 6
      },
      "thresholds": {
        "minConfidence": 0.55
      },
      "outputs": {
        "storeDetections": true,
        "storeTracks": true,
        "emitIncidents": true
      }
    },
    {
      "pipelineId": "faces-main",
      "provider": "yolo",
      "taskType": "face_detection",
      "quality": "balanced",
      "enabled": true,
      "schedule": {
        "mode": "realtime",
        "frameStride": 12
      },
      "thresholds": {
        "minConfidence": 0.7
      },
      "outputs": {
        "storeDetections": true,
        "storeFaceCrops": true,
        "storeEmbeddings": true,
        "autoClusterFaces": true,
        "emitIncidents": false
      }
    }
  ],
  "configVersion": 5,
  "updatedAt": "ISO-8601"
}
```

## 5. Modelo de datos nuevo

Extensiones sobre Prisma.

### 5.1 Configuración

- `ModelCatalogEntry`
- `InferenceNodeConfig`
- `InferenceNodeObservedState`
- `CameraDetectionProfile`
- `CameraDetectionPipeline`

### 5.2 Dominio facial

- `FaceDetection`
  - referencia a observación base
  - bbox
  - crop storage key
  - quality score
- `FaceEmbedding`
  - `faceDetectionId`
  - vector o `embeddingRef`
  - `embeddingModelRef`
  - `embeddingVersion`
  - `qualityScore`
- `FaceIdentity`
  - identidad lógica de persona
  - nombre opcional
  - estado `unresolved|confirmed|merged`
- `FaceIdentityMember`
  - relación entre embedding/detección e identidad
- `FaceCluster`
  - grupo sugerido automáticamente
- `FaceClusterMember`
  - miembros del cluster
- `FaceIdentityMergeLog`
  - historial de merge manual/asistido

## 6. Endpoints nuevos

### 6.1 Catálogo

- `GET /ops/model-catalog`
- `POST /ops/model-catalog`
- `PUT /ops/model-catalog/:id`

### 6.2 Configuración de nodos

- `GET /ops/nodes/:nodeId/config`
- `PUT /ops/nodes/:nodeId/config`
- `GET /ops/nodes/:nodeId/runtime`

Respuesta esperada:

- `desiredConfig`
- `observedConfig`
- `diff`
- `configVersion`
- `lastAppliedAt`

### 6.3 Perfiles por cámara

- `GET /cameras/:id/detection-profile`
- `PUT /cameras/:id/detection-profile`
- `POST /cameras/:id/detection-profile/validate`

### 6.4 Jobs

Mantener `POST /detections/jobs`, pero agregar contrato tipado alternativo:

```json
{
  "cameraId": "cam-001",
  "pipelineId": "faces-main",
  "source": "snapshot",
  "mode": "realtime",
  "overrides": {
    "quality": "accurate"
  }
}
```

Regla:

- si viene `pipelineId`, API resuelve configuración desde `CameraDetectionProfile`
- si viene `options`, se mantiene compatibilidad legacy

### 6.5 Caras

- `GET /cameras/:id/faces`
- `GET /faces/clusters`
- `POST /faces/clusters/:id/confirm-identity`
- `POST /faces/identities/:id/merge`
- `GET /faces/identities/:id`

## 7. Resolución de calidad

La calidad no debe viajar al nodo como string de UI. Debe resolverse antes.

Tabla de ejemplo:

- `yolo + person_detection + fast` -> `yolo26-person-n@1.0.0`
- `yolo + person_detection + balanced` -> `yolo26-person-s@1.0.0`
- `yolo + person_detection + accurate` -> `yolo26-person-m@1.0.0`
- `yolo + face_detection + balanced` -> `yolo26-face-s@1.0.0`
- `yolo + license_plate_detection + balanced` -> `yolo26-lpr-s@1.0.0`
- `mediapipe + pose_estimation + fast` -> `mediapipe_pose_lite@0.10.0`
- `mediapipe + pose_estimation + balanced` -> `mediapipe_pose@0.10.0`

## 8. Despliegue y provisioning

## 8.1 Separación conceptual

- `deploy`
  - crea/actualiza contenedor o proceso
- `provision`
  - registra capacidad deseada en control-plane
- `register`
  - nodo vivo anuncia capacidad efectiva al bridge

## 8.2 Contrato operativo v1

Se mantiene Docker Compose/Ansible como mecanismo de deploy.

La mejora v1 consiste en:

- persistir `InferenceNodeConfig` como desired state
- generar artifacts de configuración desde API o scripts de ops
- hacer visible el diff entre desired y observed

No se implementa aún:

- reconciler que edite Compose automáticamente
- Kubernetes
- autoscaling

## 8.3 Fuentes de verdad

- desired:
  - DB de API
- observed:
  - registro vivo del bridge
- deploy artifact:
  - `.env` / Compose / Ansible renderizado

## 9. Configuración en tiempo real

La UI y la API deben poder mostrar:

- qué tareas soporta cada nodo
- qué modelos y calidades tiene habilitados
- qué configuración desea control-plane
- qué configuración publicó el nodo efectivamente
- si existe drift

Diff mínimo:

```json
{
  "inSync": false,
  "items": [
    {
      "field": "models",
      "desired": ["yolo26-face-s@1.0.0"],
      "observed": ["yolo26n@1.0.0", "yolo26s@1.0.0"]
    }
  ]
}
```

## 10. Flujo facial v1

1. Pipeline `face_detection` genera detecciones de cara.
2. Se guarda crop.
3. Un extractor de embeddings genera vector.
4. Se busca similitud contra embeddings previos del mismo tenant.
5. Si supera umbral, se asocia a identidad existente.
6. Si no supera umbral, se crea cluster nuevo no resuelto.
7. Operador puede:
   - confirmar identidad
   - fusionar clusters
   - fusionar identidades

Resultado esperado de negocio:

- “estas caras parecen ser la misma persona”
- “este conjunto quedó asociado a la identidad Juan Perez”

No prometer en v1:

- identificación legal
- exactitud biométrica garantizada

## 11. Entregas recomendadas

### Entrega 1: contrato y configuración

- tablas para catálogo y perfiles
- endpoints de catálogo
- endpoints de perfil por cámara
- endpoints de config de nodo
- diff `desired` vs `observed`
- compatibilidad con jobs legacy

### Entrega 2: pipeline funcional multi-modelo

- resolución `provider + taskType + quality -> modelRef`
- `POST /detections/jobs` por `pipelineId`
- ejecución de YOLO y MediaPipe por perfil
- observabilidad de config aplicada en job/result

### Entrega 3: caras e identidad

- tablas faciales
- crops
- embeddings
- clustering básico
- merge manual de identidades

## 12. Criterio de demo cliente

La POC se considera demostrable si permite:

- configurar una cámara con:
  - personas
  - objetos
  - patentes
  - caras
  - pose
- elegir calidad por pipeline
- ver qué nodo y modelo efectivo atendieron cada job
- ver la configuración actual efectiva del nodo
- detectar caras y almacenarlas
- listar grupos de caras similares
- consolidar grupos en una identidad

## 13. Recomendación técnica concreta

Para no romper demasiado el sistema actual:

1. No reemplazar `DetectionObservation`.
2. Extender el dominio con tablas faciales nuevas.
3. Mantener `inference-bridge` como router.
4. Resolver calidad a `modelRef` en API antes de invocar el bridge.
5. Agregar `desired config` en API y `observed config` desde bridge.
6. Mantener Compose/Ansible para deploy en esta etapa.

## 14. Siguiente paso de implementación

Orden recomendado:

1. Prisma: nuevas tablas de catálogo/config/perfiles.
2. API: endpoints de catálogo y perfil.
3. API: endpoint `GET /ops/nodes/:id/config` con diff.
4. API: resolver `pipelineId` en creación de detection jobs.
5. Bridge/nodos: publicar `qualities` y `modelRefs` más explícitos.
6. Prisma/API: dominio facial.
7. UI admin: edición de perfil y visualización de drift.
