# NearHome

Sistema de monitoreo de camaras con deteccion IA, multi-tenant y chatbot para gestion via WhatsApp/Telegram.

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                      NearHome Stack                         │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Shinobi  │  │ MariaDB  │  │  Redis   │  │ YOLO     │    │
│  │   NVR    │  │   DB     │  │  Cache   │  │ Detector │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │  API     │  │  Agent   │  │ Gateway  │                  │
│  │ Multi-   │  │ Chatbot  │  │ WhatsApp │                  │
│  │ tenant   │  │          │  │ Telegram │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

## Etapas

| Etapa | Descripcion | Estado |
|-------|-------------|--------|
| 1 | Infraestructura Base (Shinobi + MariaDB + Redis) | 🔄 En progreso |
| 2 | Motor de Deteccion (YOLO) | ⏳ Pendiente |
| 3 | Sistema Multi-tenant | ⏳ Pendiente |
| 4 | Sistema de Incidencias | ⏳ Pendiente |
| 5 | Gateway Mensajeria | ⏳ Pendiente |
| 6 | Agente Chatbot MVP | ⏳ Pendiente |
| 7 | Reconocimiento Facial | ⏳ Pendiente |
| 8 | Mascaras y Deteccion Avanzada | ⏳ Pendiente |
| 9 | Servicios Adicionales (Panico, GPS) | ⏳ Pendiente |
| 10 | Dashboard Cliente | ⏳ Pendiente |

## Inicio Rapido

```bash
# Levantar stack
docker-compose up -d

# Ver logs
docker-compose logs -f shinobi

# Acceder a Shinobi
# http://localhost:8080/super
# Usuario: admin@shinobi.video
# Password: admin
```

## Estructura del Proyecto

```
nearhome/
├── docker-compose.yml
├── .env
├── api/           # API multi-tenant
├── detection/     # Motor YOLO
├── agent/         # Chatbot agente
├── gateway/       # WhatsApp/Telegram
├── dashboard/     # Frontend cliente
├── tests/         # Tests TDD
└── docs/          # Documentacion
```
