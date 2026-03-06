# NearHome - Diagrama Completo del Sistema

Fecha de corte: `2026-03-06`

```mermaid
flowchart LR
  subgraph Clients["Clientes y Operadores"]
    Admin["Admin UI (apps/admin)"]
    Portal["Portal UI (apps/portal)"]
    Ops["Operaciones / Soporte"]
  end

  subgraph Edge["Edge / Cámaras / Sensores"]
    Cam["Cámaras RTSP/RTSPS"]
    GPS["Dispositivos GPS (futuro)"]
    Panic["Botón pánico (futuro)"]
  end

  subgraph Control["Control Plane"]
    API["API Fastify (apps/api)"]
    DB[(Prisma DB - SQLite hoy)]
    Auth["Auth/RBAC con usuarios propios NearHome"]
  end

  subgraph Data["Data Plane"]
    SG["Stream Gateway (apps/stream-gateway)"]
    Storage[(Storage HLS/segmentos)]
    Engine["Media Engine\nmock | process | process-mediamtx"]
  end

  subgraph Eventing["Event Plane"]
    EG["Event Gateway (apps/event-gateway)\nWS + SSE + replay"]
    Redis[(Redis)]
  end

  subgraph Detection["Detection Plane"]
    Bridge["Inference Bridge (apps/inference-bridge)"]
    NodeY["Inference Node YOLO"]
    NodeM["Inference Node MediaPipe"]
    Dispatcher["Detection Dispatcher (Temporal starter)"]
    Worker["Detection Worker (Temporal)"]
    Temporal["Temporal Server"]
    TemporalDB[(Temporal Postgres)]
  end

  subgraph Obs["Observabilidad"]
    Prom["Prometheus"]
    Graf["Grafana"]
  end

  subgraph External["Integraciones externas (roadmap)"]
    WA["WhatsApp Business"]
    TG["Telegram Bot"]
    Bot["Agente Chatbot"]
  end

  Admin -->|REST /v1 + JWT + X-Tenant-Id| API
  Portal -->|REST /v1 + JWT + X-Tenant-Id| API
  Admin -->|WS/SSE tenant-scoped| EG
  Portal -->|WS/SSE tenant-scoped| EG

  API --> DB
  API --> Auth
  API -->|provision/deprovision + health sync| SG
  API -->|publish eventos internos| EG
  API -->|dispatch workflows detección| Dispatcher
  API -->|callback ingest (complete/fail)| Worker

  SG --> Storage
  SG --> Engine
  Engine -->|ingesta RTSP/RTSPS| Cam
  Engine -->|frames/eventos técnicos| Bridge

  SG -->|playback HLS tokenizado| Admin
  SG -->|playback HLS tokenizado| Portal

  EG --> Redis
  EG -->|replay/stream| Admin
  EG -->|replay/stream| Portal

  Dispatcher --> Temporal
  Worker --> Temporal
  Temporal --> TemporalDB
  Worker --> Bridge
  Bridge --> NodeY
  Bridge --> NodeM
  Worker -->|resultados detección| API

  SG -->|/metrics| Prom
  API -->|/metrics (futuro)| Prom
  EG -->|/metrics (futuro)| Prom
  Prom --> Graf

  API -->|incidentes/notificaciones (roadmap)| WA
  API -->|incidentes/notificaciones (roadmap)| TG
  Bot -->|comandos y acciones (roadmap)| API

  GPS -.-> API
  Panic -.-> API
```

## Lectura rápida

- `apps/api` orquesta control-plane, entitlements, lifecycle, sesiones y coordinación de streaming/detección.
- `apps/stream-gateway` mantiene contrato de playback tokenizado y desacopla el motor de media.
- `apps/event-gateway` desacopla realtime (WS/SSE) con replay por tenant.
- Detection plane ejecuta jobs vía Temporal + bridge de inferencia con nodos on-prem.
- La autenticación/autorización actual usa usuarios propios NearHome (RBAC multi-tenant).
- Integraciones de mensajería, GPS y pánico están modeladas como extensión del roadmap GitHub.
