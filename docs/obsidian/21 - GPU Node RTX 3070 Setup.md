---
tags: [nearhome, gpu, rtx3070, setup]
status: draft
---

# GPU Node RTX 3070 Setup

## Responsabilidad

La Linux box recibe RTSP por WireGuard, captura frames y ejecuta detectores. No
debe ser el control plane publico ni exponer directamente inference endpoints.

## Preparacion

```bash
bash scripts/deploy/setup-gpu-node.sh
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi
```

## Variables

```bash
cp infra/docker-compose.gpu.env.example infra/.env.gpu
```

Completar:

- `GPU_NODE_TAILSCALE_IP`
- `MAC_TAILSCALE_IP` o IP del control plane vigente
- `NODE_AUTH_ADMIN_SECRET`
- `NODE_ENROLLMENT_TOKEN` si el bridge lo requiere

Validar sin desplegar:

```bash
docker compose --env-file infra/.env.gpu -f infra/docker-compose.gpu.yml config
```

## Deploy

```bash
docker compose --env-file infra/.env.gpu -f infra/docker-compose.gpu.yml up -d --build
```

## Criterio de readiness

- Driver y Container Toolkit saludables.
- Modelo/engine cargado y warmup terminado.
- Heartbeat visible en inference bridge.
- VRAM declarada coincide con `nvidia-smi`.
- No usar `NODE_MAX_CONCURRENT=8` como supuesto de capacidad: empezar con 1-2.
- Benchmark obligatorio antes de aumentar camaras o FPS.

## Fuente tecnica

- [GPU setup actual](../gpu-node-setup.md)
- [Detector DESIGN](../sdd/detector-pipeline/DESIGN.md)
- [Edge DESIGN](../sdd/edge-node/DESIGN.md)
