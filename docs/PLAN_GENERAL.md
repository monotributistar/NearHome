# NearHome - Plan General Sincronizado

Fecha de actualización: `2026-03-04`

## 1) Estado de referencia

- Plataforma actual (control-plane + data-plane + detection/event plane) está operativa en modo POC avanzado.
- Sync GitHub: `18` issues abiertos, `1` issue cerrado.
- Fuente de verdad de roadmap externo: issues de `monotributistar/NearHome`.

## 2) Objetivo de ejecución

Cerrar la brecha entre el POC técnico actual y el roadmap funcional publicado en GitHub, priorizando:

1. hardening productivo (seguridad, CI/CD, docs API),
2. integración real de ingest/detección,
3. features de producto (incidencias, mensajería, dashboard, servicios cliente).

## 3) Principios de priorización

- Seguridad y despliegue antes de expansión funcional.
- Cerrar dependencias técnicas antes de features UI.
- Mantener contratos estables (`ControlPlane/DataPlane`) al introducir nuevos motores.
- Cada fase con criterios de salida testeables.

## 4) Plan de trabajo por fases (sincronizado con GitHub issues)

### Fase A - Hardening de plataforma (actual)

Issues:
- `#16` CI/CD con GitHub Actions
- `#18` SSL/TLS con Let's Encrypt
- `#19` Rate limiting por tenant
- `#15` Documentación OpenAPI/Swagger

Entregables:
- pipeline CI para test/typecheck/build/e2e smoke,
- terminación TLS en entorno deploy,
- límites de tráfico por tenant/ruta sensible,
- spec OpenAPI y publicación interna.

Criterio de salida:
- deploy reproducible + políticas de seguridad básicas activas.

### Fase B - Ingesta y detección operativa

Issues:
- `#1` plugin Shinobi-YOLO para envío de frames
- `#2` test integración YOLO con video real
- `#3` endpoint gestión de máscaras por cámara
- `#10` editor visual de zonas

Entregables:
- flujo end-to-end de frame ingest -> inferencia -> evento,
- pruebas de video real automatizadas,
- API de máscaras consistente con UI de zonas.

Criterio de salida:
- detección validada con fuentes reales y configuración ROI usable.

### Fase C - Incidencias y mensajería

Issues:
- `#5` workflow de incidencias
- `#6` WhatsApp Business API
- `#7` Telegram Bot
- `#8` comandos básicos de agente/chatbot

Entregables:
- workflow incidente con niveles/escalado,
- gateway de salida de notificaciones multicanal,
- comandos base del agente para consulta/acción.

Criterio de salida:
- incidente puede nacer, escalar y notificarse en canales externos.

### Fase D - Servicios y experiencia cliente

Issues:
- `#11` botón de pánico
- `#12` tracking GPS familia
- `#13` mapa de propiedad
- `#14` métricas y estadísticas dashboard

Entregables:
- funcionalidades cliente de emergencia y tracking,
- dashboard visual con mapa + KPIs operativos.

Criterio de salida:
- experiencia portal lista para piloto controlado.

### Fase E - Reconocimiento facial

Issues:
- `#9` registro de rostros

Entregables:
- registro/matching de rostros con controles de privacidad y auditoría.

Criterio de salida:
- feature habilitable por tenant con trazabilidad completa.

## 5) Dependencias críticas

- `#16` y `#18` bloquean cualquier salida productiva seria.
- `#1/#2` son prerequisito técnico para estabilizar `#9/#10`.
- `#3` desbloquea diseño final de `#10`.
- `#5` es base para `#6/#7/#8`.

## 6) Criterios de calidad transversales

- `pnpm typecheck` en verde.
- tests unit/integration de servicios tocados.
- e2e smoke de Admin/Portal en verde.
- documentación contractual actualizada por cambio de comportamiento.
