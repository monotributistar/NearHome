# GPU Inference Node — Integración de Linux RTX 3060

## Arquitectura

```
┌───────────────────────────────────┐       ┌──────────────────────────────┐
│         macOS M4 Max              │       │    Linux Ubuntu RTX 3060    │
│                                   │       │                              │
│  Caddy :8080       (control)      │       │  ┌──────────────────────┐   │
│  API               (data)         │       │  │ inference-node-yolo  │   │
│  Stream Gateway    (event)        │       │  │  :8091 (GPU/CUDA)    │   │
│  Event Gateway     (detection)    │       │  ├──────────────────────┤   │
│  Frame Hub         (bridge)       │◄──────┤  │ inference-node-      │   │
│  inference-bridge  :8090          │Tailnet│  │ mediapipe :8092      │   │
│  Redis             (queue)        │       │  ├──────────────────────┤   │
│  Frame Grabber     (RTSP)         │       │  │ inference-node-      │   │
│  RTSP Sim                        │       │  │ tensorrt :8093       │   │
└───────────────────────────────────┘       │  │ (YOLO + TensorRT)    │   │
                                            │  └──────────────────────┘   │
                                            │                              │
                                            │  GPU: RTX 3060 12GB VRAM    │
                                            │  CUDA 12.x + TensorRT 10.x  │
                                            │  Docker + nvidia-container  │
                                            └──────────────────────────────┘
```

**Comunicación:** Tailscale Tailnet. Ambos equipos en la misma red privada VPN.
El inference-bridge (macOS) ve los nodos Linux por su IP de Tailscale.

## Por qué esta arquitectura

| Aspecto | macOS M4 Max | Linux RTX 3060 |
|---------|-------------|----------------|
| GPU para inferencia | No (Docker sin --gpus) | Si, 12GB VRAM |
| CPU | 14 cores (muy bueno) | Variable |
| Ideal para | Control plane, streaming, frontend | Cómputo pesado (YOLO, TensorRT, face) |
| Stack Docker | Limitado (ARM64) | Nativo (x86_64) |

## Setup del nodo Linux (paso a paso)

### 1. Prerrequisitos en la Linux box

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# NVIDIA drivers + CUDA
sudo apt install nvidia-driver-550 nvidia-utils-550
# Verificar
nvidia-smi
# Deberías ver la RTX 3060

# NVIDIA Container Toolkit
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Verificar GPU en Docker
docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi

# Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Autenticar en el browser
```

### 2. Conectar a la Tailnet

```bash
# En la Linux box:
sudo tailscale up --accept-routes

# Verificar IP
tailscale ip -4
# → 100.x.x.x (esta es la IP que usará el inference-bridge)

# En macOS, verificar que se vean
tailscale ping 100.x.x.x
```

### 3. Configurar Docker context (gestión remota desde macOS)

```bash
# En macOS, crear un contexto Docker para la Linux box
docker context create gpu-node \
  --docker "host=ssh://tu-usuario@100.x.x.x"

# Usarlo
docker --context gpu-node ps

# Ver TODOS los contenedores en ambas máquinas
docker --context default ps   # macOS
docker --context gpu-node ps  # Linux

# Hacer deploy a la Linux box
docker --context gpu-node compose -f infra/docker-compose.gpu.yml up -d
```

### 4. Deploy de los detectores GPU

Se crea un `docker-compose.gpu.yml` específico para la Linux box:

```yaml
name: nearhome-gpu-node

services:
  inference-node-yolo:
    build:
      context: ../
      dockerfile: apps/inference-node-yolo/Dockerfile
    image: nearhome/inference-node-yolo:gpu
    runtime: nvidia
    environment:
      NODE_ID: node-yolo-gpu-1
      NODE_RUNTIME: yolo
      NODE_ENDPOINT: http://100.x.x.x:8091
      NODE_RESOURCES_GPU: "1"
      NODE_RESOURCES_VRAM_MB: "12288"
      NODE_MAX_CONCURRENT: "8"
      YOLO_MODEL: yolo11n.pt
      YOLO_CONF: "0.25"
      YOLO_MAX_DET: "20"
      YOLO_RESOLUTION: "640"
      # inference-bridge corre en macOS, accesible via Tailscale
      INFERENCE_BRIDGE_URL: http://100.y.y.y:8090
      NODE_HEARTBEAT_INTERVAL_MS: "10000"
    ports:
      - "8091:8091"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

  inference-node-tensorrt:
    build:
      context: ../
      dockerfile: apps/inference-node-tensorrt/Dockerfile
    image: nearhome/inference-node-tensorrt:gpu
    runtime: nvidia
    environment:
      NODE_ID: node-tensorrt-1
      NODE_RUNTIME: tensorrt
      NODE_ENDPOINT: http://100.x.x.x:8093
      NODE_RESOURCES_GPU: "1"
      NODE_RESOURCES_VRAM_MB: "12288"
      NODE_MAX_CONCURRENT: "12"
      YOLO_MODEL: yolo11n.engine    # modelo compilado a TensorRT
      YOLO_CONF: "0.25"
      YOLO_MAX_DET: "20"
      YOLO_RESOLUTION: "640"
      INFERENCE_BRIDGE_URL: http://100.y.y.y:8090
    ports:
      - "8093:8093"

  inference-node-tensorrt-builder:
    # Contenedor one-shot para compilar .pt → .engine
    image: nearhome/inference-node-tensorrt:gpu
    entrypoint: ["python", "-m", "tensorrt_builder"]
    environment:
      YOLO_MODEL_SRC: yolo11n.pt
      YOLO_MODEL_DST: yolo11n.engine
    volumes:
      - ./models:/models
    runtime: nvidia
    profiles:
      - build
```

## Pipeline de detección con GPU

El inference-bridge (macOS) ya tiene lógica de ruteo. Cuando recibe un frame:

```
frame-grabber (macOS)
  → Frame Hub (macOS) :8100
  → Pipeline Runner lee policy de cámara
  → inference-bridge (macOS) :8090
  → Rutea según capabilities de nodos registrados:
      ├─ node-yolo-gpu-1 (Linux, GPU, CUDA)   → alta velocidad
      ├─ node-tensorrt-1 (Linux, GPU, TRT)    → máxima velocidad
      └─ node-yolo-1 (macOS, CPU, ONNX)       → fallback
  → Result Merger (macOS)
  → Event Gateway (macOS)
```

El bridge elige el nodo según:
1. **Disponibilidad** (queueDepth bajo)
2. **Velocidad** (TensorRT > CUDA > ONNX)
3. **Recursos** (GPU > CPU)

## Compilación TensorRT (para máxima velocidad)

La RTX 3060 soporta TensorRT, que da **10-20x sobre PyTorch** en YOLO:

```bash
# En la Linux box (con GPU)
docker compose --profile build run inference-node-tensorrt-builder

# Esto compila yolo11n.pt → yolo11n.engine (optimizado para RTX 3060)
# El .engine resultante se guarda en ./models/

# Benchmarks esperados para YOLO11n en RTX 3060:
#   PyTorch (CUDA):  ~8-12ms por frame
#   ONNX (CUDA):     ~5-8ms
#   TensorRT (FP16): ~2-4ms  ← esto es ~500 fps
```

## Gestión diaria

```bash
# Ver nodos conectados al bridge
curl -s http://localhost:8080/infer/v1/nodes | python3 -m json.tool

# Ver logs de la Linux box
docker --context gpu-node logs -f nearhome-gpu-node-inference-node-yolo-1

# Actualizar detectores en la Linux box
cd /Users/monotributistar/SOURCES/NearHome
docker --context gpu-node compose -f infra/docker-compose.gpu.yml build
docker --context gpu-node compose -f infra/docker-compose.gpu.yml up -d

# Hacer SSH a la Linux box directamente
ssh usuario@100.x.x.x

# Ver uso de GPU
docker --context gpu-node run --rm --gpus all nvidia/cuda:12.2.0-base nvidia-smi

# Monitorear en tiempo real
watch -n 1 docker --context gpu-node stats
```

## Archivos a crear/agregar

| Archivo | Propósito |
|---------|-----------|
| `infra/docker-compose.gpu.yml` | Stack de detectores GPU para Linux |
| `infra/docker-compose.gpu.env.example` | Variables de entorno (IPs, tokens) |
| `scripts/deploy/setup-gpu-node.sh` | Script de bootstrap de la Linux box |
| `scripts/deploy/deploy-gpu-nodes.sh` | Deploy + update remoto via Docker context |
| `docs/gpu-node-setup.md` | Documentación de setup (este documento) |

## Bonus: inference-bridge como load balancer

El inference-bridge ya soporta múltiples nodos registrados para el mismo taskType.
Si agregás más Linux boxes con GPU en el futuro, el bridge balancea automáticamente:

```json
// GET /v1/nodes
{
  "data": [
    {"nodeId": "node-yolo-gpu-1", "queueDepth": 0, "status": "online"},
    {"nodeId": "node-yolo-gpu-2", "queueDepth": 3, "status": "online"},
    {"nodeId": "node-yolo-1", "queueDepth": 0, "status": "online"}
  ]
}
```

El bridge siempre elige el nodo con menor queueDepth para el taskType solicitado.
