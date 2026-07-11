---
tags: [nearhome, status, poc]
status: active
---

# Product Status

## Implementado y validado

- Monorepo PNPM con API, admin, portal, stream gateway y event gateway.
- Registro, heartbeat y discovery autenticado de edge gateways.
- Discovery agent con pruebas unitarias.
- Nodos YOLO, MediaPipe y TensorRT en desarrollo.
- Compose PoC local y compose GPU validables.
- SDD del edge y pipeline de deteccion.
- Baseline edge: API 10/10, discovery agent 8/8 y typecheck correcto.

## Parcial

- Pipeline local de frames y deteccion: sirve como demo, aun tiene rutas legacy.
- GPU node: definido, no probado live en la RTX 3070 desde este checkpoint.
- Dos VPN: diseño y scripts presentes, sin prueba end-to-end multi-edge.
- Storage: filesystem local para demo; object storage y URLs firmadas pendientes.

## No demostrado

- Dos edge nodes aislados ejecutando simultaneamente.
- Raspberry Pi real con WireGuard y control VPN durante un soak test.
- Benchmark 1/4/8/12 camaras en RTX 3070.
- Recuperacion completa ante caida de internet, RTSP, detector o storage.
- Aislamiento negativo end-to-end de playback y evidencia.

## Deuda conocida

- Las suites VPN legacy usan `/api/v1/vpns`; el contrato vigente usa
  `/network/tenants/:tenantId/vpns`.
- `detector:8000`, `inference-node-yolo` e `inference-node-tensorrt` se solapan.
- La ruta objetivo es `inference-bridge -> inference-node-tensorrt`.
- BalenaOS debe evaluarse despues de validar Docker directo en Raspberry Pi OS.
