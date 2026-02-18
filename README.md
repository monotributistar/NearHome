# NearHome

Sistema de monitoreo de camaras con deteccion IA, multi-tenant y chatbot para gestion via WhatsApp/Telegram.

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         NearHome Stack                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────┐                                                           │
│   │  Camara  │                                                           │
│   │   RTSP   │                                                           │
│   └────┬─────┘                                                           │
│        │                                                                 │
│        ▼                                                                 │
│   ┌──────────┐     Deteccion      ┌──────────┐                          │
│   │ Shinobi  │────Movimiento─────▶│   YOLO   │                          │
│   │   NVR    │                    │ Detector │                          │
│   │(grabacion│                    │(personas,│                          │
│   │ continua)│                    │ vehiculos│                          │
│   └──────────┘                    └────┬─────┘                          │
│        │                               │                                 │
│        │                          Eventos                                │
│        │                               ▼                                 │
│        │                         ┌──────────┐                           │
│        │                         │ NearHome │                           │
│        │                         │   API    │                           │
│        │                         │(incidenc.│                           │
│        │                         └────┬─────┘                           │
│        │                              │                                  │
│   ┌────┴──────┐    ┌──────────┐      │                                  │
│   │  MariaDB  │    │  Redis   │◄─────┘                                  │
│   │    DB     │    │  Cache   │                                          │
│   └───────────┘    └──────────┘                                          │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐                              │
│   │  Agent   │  │ Gateway  │  │ Dashboard│                              │
│   │ Chatbot  │  │ WhatsApp │  │ Cliente  │                              │
│   │          │  │ Telegram │  │          │                              │
│   └──────────┘  └──────────┘  └──────────┘                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Flujo de Deteccion (Arquitectura Hibrida)

1. Camara envia stream RTSP a **Shinobi**
2. Shinobi detecta movimiento (nativo)
3. Solo frames con movimiento van a **YOLO Detector**
4. YOLO clasifica: persona / vehiculo / otro
5. **NearHome API** genera incidencia segun reglas
6. **Gateway** notifica al cliente via WhatsApp/Telegram

## Etapas

| Etapa | Descripcion | Estado |
|-------|-------------|--------|
| 1 | Infraestructura Base (Shinobi + MariaDB + Redis) | ✅ Completada |
| 2 | Motor de Deteccion (YOLO) + API Multi-tenant | 🔄 En progreso |
| 3 | Sistema Multi-tenant | 🔄 En progreso |
| 4 | Sistema de Incidencias | 🔄 En progreso |
| 5 | Gateway Mensajeria | ⏳ Pendiente |
| 6 | Agente Chatbot MVP | ⏳ Pendiente |
| 7 | Reconocimiento Facial | ⏳ Pendiente |
| 8 | Mascaras y Deteccion Avanzada | ⏳ Pendiente |
| 9 | Servicios Adicionales (Panico, GPS) | ⏳ Pendiente |
| 10 | Dashboard Cliente | ⏳ Pendiente |

## Inicio Rapido

```bash
# Levantar stack completo
docker-compose up -d

# Ver logs
docker-compose logs -f

# Endpoints:
# - Shinobi NVR:    http://localhost:8080
# - NearHome API:   http://localhost:8000
# - YOLO Detector:  http://localhost:8001

# Acceder a Shinobi (super usuario)
# http://localhost:8080/super
# Usuario: admin@shinobi.video
# Password: admin
```

## Estructura del Proyecto

```
nearhome/
├── docker-compose.yml      # Stack completo
├── .env                    # Variables de entorno
├── init-db/                # Scripts SQL inicializacion
├── api/                    # API FastAPI multi-tenant
│   ├── main.py             # Endpoints
│   ├── models.py           # Modelos SQLAlchemy
│   ├── schemas.py          # Schemas Pydantic
│   └── Dockerfile
├── detection/              # Motor YOLO
│   ├── main.py             # API deteccion
│   ├── detector.py         # Clase YOLODetector
│   ├── models.py           # Modelos Pydantic
│   └── Dockerfile
├── agent/                  # Chatbot agente (futuro)
├── gateway/                # WhatsApp/Telegram (futuro)
├── dashboard/              # Frontend cliente (futuro)
├── tests/                  # Tests TDD
│   ├── test_etapa1_infra.py
│   └── test_etapa2_detection.py
└── docs/                   # Documentacion
```

## API Endpoints

### NearHome API (puerto 8000)

| Metodo | Endpoint | Descripcion |
|--------|----------|-------------|
| GET | /health | Health check |
| POST | /clients | Crear cliente |
| GET | /clients | Listar clientes |
| POST | /cameras | Crear camara |
| GET | /cameras | Listar camaras |
| POST | /incidences | Crear incidencia |
| GET | /incidences | Listar incidencias |
| POST | /events/detection | Procesar evento de deteccion |

### YOLO Detector (puerto 8001)

| Metodo | Endpoint | Descripcion |
|--------|----------|-------------|
| GET | /health | Health check |
| POST | /detect | Detectar objetos en frame |
| POST | /detect/batch | Detectar en multiples frames |
