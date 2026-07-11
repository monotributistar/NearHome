---
tags: [nearhome, index]
status: active
---

# NearHome

## Objetivo actual

Llegar a una PoC funcional multi-tenant:

```text
Camera -> Edge Node -> WireGuard -> Frame Grabber -> Detector RTX 3070
       -> Metadata + Evidence -> API/Event Gateway -> Client
```

## Empezar aca

1. [[01 - Product Status]]
2. [[02 - Architecture Map]]
3. [[10 - Local Development Setup]]
4. [[11 - Credentials and Environment Variables]]
5. [[12 - Validation Checklist]]
6. [[20 - Edge Node Setup]]
7. [[21 - GPU Node RTX 3070 Setup]]

## Fuente de verdad

- El codigo, Compose y tests son la fuente de verdad operativa.
- Los SDD definen el contrato objetivo.
- Este vault organiza y enlaza; no reemplaza los documentos fuente.
- Nunca guardar secretos reales dentro del vault.

## SDD activos

- [Edge SPEC](../sdd/edge-node/SPEC.md)
- [Edge DESIGN](../sdd/edge-node/DESIGN.md)
- [Edge TASKS](../sdd/edge-node/TASKS.md)
- [Detector SPEC](../sdd/detector-pipeline/SPEC.md)
- [Detector DESIGN](../sdd/detector-pipeline/DESIGN.md)

## Estado de entrega

- Fase 0: implementada, excepto rotacion externa de la antigua clave WireGuard.
- Fase 1: pendiente, simulacion reproducible de dos edge nodes.
- Hardware: Raspberry Pi y RTX 3070 aun requieren validacion live.
