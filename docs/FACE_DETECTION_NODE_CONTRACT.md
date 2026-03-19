# Face Detection Node Contract

Fecha: `2026-03-14`
Estado: `working contract`

## Objetivo

Dejar explícito el contrato operativo para `face_detection` en NearHome: qué configura control-plane, qué debe publicar un nodo, cómo se despliega y qué debe poder observarse en runtime.

## 1. Contrato funcional

Para detección de rostro, el pipeline de cámara debe declarar:

```json
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
    "autoClusterFaces": true
  }
}
```

Expectativa mínima:
- guardar detección de cara
- guardar crop si `storeFaceCrops=true`
- guardar embedding si `storeEmbeddings=true`
- permitir clustering y asociación posterior

## 2. Contrato de catálogo de modelos

El catálogo debe poder resolver, como mínimo:

```json
{
  "provider": "yolo",
  "taskType": "face_detection",
  "quality": "balanced",
  "modelRef": "yolo26-face-s@1.0.0",
  "status": "active"
}
```

Puntos obligatorios:
- `provider`, `taskType`, `quality` identifican el modelo lógico
- `modelRef` identifica el artefacto real
- `status=active` habilita resolución desde camera profile y topology

## 3. Contrato deseado del nodo

El desired config del nodo debe declarar soporte facial en `capabilities` y `models`.

Shape mínima:

```json
{
  "nodeId": "node-yolo-face-01",
  "runtime": "yolo",
  "transport": "http",
  "endpoint": "http://inference-node-yolo:8091",
  "resources": {
    "cpu": 8,
    "gpu": 1,
    "vramMb": 8192
  },
  "capabilities": [
    {
      "capabilityId": "faces",
      "taskTypes": ["face_detection"],
      "qualities": ["balanced"],
      "modelRefs": ["yolo26-face-s@1.0.0"]
    }
  ],
  "models": ["yolo26-face-s@1.0.0"],
  "tenantIds": [],
  "maxConcurrent": 4,
  "contractVersion": "1.0"
}
```

## 4. Contrato observado del nodo

El nodo registrado en bridge debe publicar:
- `status`
- `endpoint`
- `resources`
- `capabilities`
- `models`
- `queueDepth`
- `isDrained`
- `lastHeartbeatAt`

Para `face_detection`, control-plane considera runnable un nodo si:
- publica `taskType=face_detection`
- expone un `modelRef` compatible
- está `online`
- no está drenado
- el tenant está dentro del scope

## 5. Despliegue actual

Hoy el deploy real de nodos sigue apoyado en:
- `infra/docker-compose.yml`
- `ansible/roles/nearhome_stack/templates/env.onprem.j2`
- contrato de autenticación/registro en `docs/NODE_AUTH_CONTRACT.md`

La API de provisioning actual (`POST /ops/nodes/provision`) crea intención operativa y desired state, pero no crea infraestructura por sí sola.

Para cerrar el contrato operativo, control-plane ahora también puede exportar una definición concreta de despliegue por nodo vía `GET /ops/nodes/:nodeId/deploy-definition`.

Ese endpoint devuelve:
- `source`: si la definición sale de `desired` o de `observed`
- `runtime`, `serviceName`, `imageHint`
- `env` efectiva para el contenedor
- `ports`, `dependsOn`, `networks`
- `composeService` con un snippet directamente usable como base de `docker-compose`
- `warnings` cuando falta declarar task types o modelos

Ruta operativa recomendada:
- exportar overrides con `pnpm pilot:detection:export`
- revisar `infra/docker-compose.detection.generated.yml`
- levantar `pnpm pilot:stack:up:onprem`

En modo on-prem, `stack-up` consume automáticamente `infra/docker-compose.detection.generated.yml` si existe. Si no existe, hace fallback a nodos estáticos de laboratorio.

## 6. Observabilidad mínima

Para considerar sano el runtime facial, debe poder verse:
- entrada activa en `model-catalog` para `face_detection`
- nodo con soporte facial en `ops/nodes`
- `desiredConfig` y `observedConfig` del nodo
- `diff.inSync`
- cámara con `detection-profile` válido
- topology runnable para `faces-main`

## 7. APIs relevantes

- `GET /ops/model-catalog`
- `GET /ops/nodes`
- `GET /ops/nodes/:nodeId/config`
- `GET /ops/nodes/:nodeId/deploy-definition`
- `POST /ops/nodes/:nodeId/config/apply`
- `GET /cameras/:id/detection-profile`
- `POST /cameras/:id/detection-profile/validate`
- `GET /cameras/:id/detection-topology`
- `GET /cameras/:id/faces`
- `GET /faces/identities`
- `GET /faces/identities/:id`

## 8. UI operativa disponible

En `admin` hoy ya se puede:
- ver catálogo de modelos faciales
- ver nodos con soporte `face_detection`
- comparar desired vs observed
- aplicar configuración deseada
- investigar caras, identidades y merges

Pantallas clave:
- `/operations/nodes`
- `/resources/cameras/:id`
- `/resources/faces`

## 9. Gap actual

Lo que sigue pendiente para cerrar el lifecycle completo:
- orquestación real del deployment del nodo
- versionado explícito de artefactos de embeddings
- health específico del pipeline facial
- reconciliación automática de drift para nodos faciales
