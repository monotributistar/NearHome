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

## Arquitectura de Red (Segmentacion por Funcion)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         RED FRONTEND (10.20.0.0/24)                      │
│                         Acceso publico limitado                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                         NGINX (Reverse Proxy)                     │   │
│  │                    Puerto 80/443 (unico expuesto)                │   │
│  └─────────────────────────────┬────────────────────────────────────┘   │
└────────────────────────────────┼─────────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   /api/*        │    │   /docs         │    │   /*            │
│   NearHome API  │    │   Swagger       │    │   Shinobi       │
└────────┬────────┘    └─────────────────┘    └────────┬────────┘
         │                                             │
┌────────┴────────────────────────────────────────────┴───────────────────┐
│                         RED BACKEND (10.10.0.0/24)                       │
│                         RED INTERNA - Sin acceso externo                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │   API    │  │ Detector │  │  Redis   │  │ MariaDB  │  │ Shinobi  │  │
│  │  :8000   │  │  :8001   │  │  :6379   │  │  :3306   │  │  :8080   │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────┬───────────────────────────────┘
                                          │
┌─────────────────────────────────────────┴───────────────────────────────┐
│                         RED CAMARAS (10.30.0.0/24)                       │
│                         Solo RTSP hacia Shinobi                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                │
│  │ Camara 1 │  │ Camara 2 │  │ Camara N │  │  Shinobi │                │
│  │  RTSP    │  │  RTSP    │  │  RTSP    │  │ (recibe) │                │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Reglas de Aislamiento

| Red | Servicios | Acceso Externo | Comunicacion |
|-----|-----------|----------------|--------------|
| **Backend** | API, Detector, MariaDB, Redis | NO | Interna entre servicios |
| **Frontend** | Nginx | SI (80/443) | Solo a API y Shinobi |
| **Camaras** | Shinobi, Camaras IP | NO | Solo RTSP hacia Shinobi |

### Seguridad

- Backend no expuesto a internet
- API y Detector solo accesibles via Nginx
- Cámaras aisladas del resto de servicios
- Multi-tenant logico via `tenant_id` en aplicacion

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

# Endpoints (todos via Nginx puerto 80):
# - Shinobi NVR:    http://localhost/
# - NearHome API:   http://localhost/api/
# - Swagger Docs:   http://localhost/docs
# - YOLO Detector:  Solo interno (no expuesto)

# Acceder a Shinobi (super usuario)
# http://localhost/super
# Usuario: admin@shinobi.video
# Password: admin
```

## Estructura del Proyecto

```
nearhome/
├── docker-compose.yml      # Stack completo con redes segmentadas
├── .env                    # Variables de entorno
├── nginx/                  # Reverse proxy
│   ├── nginx.conf          # Configuracion Nginx
│   └── ssl/                # Certificados SSL (futuro)
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

### NearHome API (via Nginx: /api/)

| Metodo | Endpoint | Descripcion |
|--------|----------|-------------|
| GET | /api/health | Health check |
| POST | /api/clients | Crear cliente |
| GET | /api/clients | Listar clientes |
| POST | /api/cameras | Crear camara |
| GET | /api/cameras | Listar camaras |
| POST | /api/incidences | Crear incidencia |
| GET | /api/incidences | Listar incidencias |
| POST | /api/events/detection | Procesar evento de deteccion |

### YOLO Detector (Solo interno)

| Metodo | Endpoint | Descripcion |
|--------|----------|-------------|
| GET | /health | Health check |
| POST | /detect | Detectar objetos en frame |
| POST | /detect/batch | Detectar en multiples frames |

> Nota: YOLO Detector no esta expuesto externamente. Solo accesible desde la red backend.
