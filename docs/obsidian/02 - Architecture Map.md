---
tags: [nearhome, architecture]
status: active
---

# Architecture Map

## Capas

| Capa      | Componentes                       |     Puerto local | Plano        |
| --------- | --------------------------------- | ---------------: | ------------ |
| Web       | Admin, Portal, Caddy              | 5173, 5174, 8080 | cliente      |
| Control   | API                               |             3001 | control      |
| Events    | Event Gateway SSE                 |             3011 | eventos      |
| Media     | Stream Gateway, MediaMTX          |       3010, 8554 | video        |
| Dispatch  | Inference Bridge                  |             8090 | deteccion    |
| Inference | YOLO, MediaPipe, TensorRT         | 8091, 8092, 8093 | deteccion    |
| Edge      | Discovery agent, WireGuard router |     host network | edge         |
| Data      | SQLite local, filesystem demo     |          interno | persistencia |

## Separacion de planos

### Control plane

- API, heartbeat, discovery, configuracion y observabilidad.
- Tailscale o Headscale entre edge y hub.
- Autenticacion de aplicacion obligatoria aunque exista VPN.

### Video plane

- RTSP desde LAN de camaras hasta Linux box por WireGuard.
- Solo el hub puede iniciar trafico hacia CIDR y puertos autorizados.
- Playback e inferencia comparten media ingress cuando sea posible, pero sus
  fallos no deben bloquearse mutuamente.

### Client plane

- HLS autenticado para video.
- SSE autenticado para metadata.
- Evidencia mediante URL firmada, no filesystem publico.

## Documentos relacionados

- [Control y data plane](../CONTROLPLANE_DATAPLANE_CONTRACT.md)
- [Contratos de componentes](../CONTRATOS_COMPONENTES.md)
- [Diagramas](../DIAGRAMAS_PLANES.md)
- [Edge DESIGN](../sdd/edge-node/DESIGN.md)
