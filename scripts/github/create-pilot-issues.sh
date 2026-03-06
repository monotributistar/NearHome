#!/usr/bin/env bash
set -euo pipefail

REPO="monotributistar/NearHome"

retry() {
  local tries=0
  local max=8
  until "$@"; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$max" ]; then
      echo "FAILED: $*" >&2
      return 1
    fi
    sleep 2
  done
}

ensure_label() {
  local name="$1"
  local color="$2"
  local description="$3"
  retry gh label create "$name" --repo "$REPO" --color "$color" --description "$description" >/tmp/nh_label_out 2>/tmp/nh_label_err || true
  if rg -q "already exists" /tmp/nh_label_err 2>/dev/null; then
    :
  elif [ -s /tmp/nh_label_err ]; then
    cat /tmp/nh_label_err >&2
  fi
}

ensure_milestone() {
  local title="$1"
  local description="$2"
  retry gh api -X POST "repos/${REPO}/milestones" -f title="$title" -f description="$description" >/tmp/nh_ms_out 2>/tmp/nh_ms_err || true
  if rg -q "already_exists|Validation Failed" /tmp/nh_ms_err 2>/dev/null; then
    :
  elif [ -s /tmp/nh_ms_err ]; then
    cat /tmp/nh_ms_err >&2
  fi
}

create_issue() {
  local title="$1"
  local labels="$2"
  local body_file="$3"
  retry gh issue create --repo "$REPO" --title "$title" --body-file "$body_file" --label "$labels"
}

ensure_label "pilot" "1D76DB" "Pilot scope and acceptance"
ensure_label "phase:deploy" "0052CC" "Deploy/on-prem/tunnel"
ensure_label "phase:detection" "D73A4A" "Detection E2E"
ensure_label "phase:messaging" "5319E7" "Messaging integrations"
ensure_label "phase:qa" "0E8A16" "Smoke/acceptance tests"
ensure_label "phase:runbook" "FBCA04" "Operational runbooks"

ensure_milestone "Fase A - Hardening de plataforma" "CI/CD, TLS, rate limiting y OpenAPI"
ensure_milestone "Fase B - Ingesta y deteccion operativa" "RTSP directo + nodos de deteccion, video real y mascaras/zonas"
ensure_milestone "Fase C - Incidencias y mensajeria" "Workflow incidentes e integraciones Telegram"
ensure_milestone "Fase D - Servicios cliente y dashboard" "Panico, GPS, mapa y metricas"
ensure_milestone "Fase E - Reconocimiento facial" "Registro y matching de rostros"

cat >/tmp/epic1.md <<'MD'
## Objetivo
Tener despliegue reproducible en local y on-premise, expuesto por Cloudflare Tunnel con dominio estable para piloto.

## Alcance
- Perfil de compose para local y para on-prem.
- Variables de entorno separadas (`.env.local`, `.env.onprem`).
- Cloudflare Tunnel configurado para Admin, Portal, API y Event Gateway.
- Healthchecks y verificación de reachability.

## Criterios de aceptación
- [ ] Stack levanta en local con un comando documentado.
- [ ] Stack levanta en on-prem con un comando documentado.
- [ ] Dominio público (tunnel) responde en HTTPS para UI/API.
- [ ] Hay checklist de rollback básico.
MD

cat >/tmp/epic2.md <<'MD'
## Objetivo
Mostrar flujo de detección con impacto visual completo: ingest -> detección -> evento/incidente -> UI realtime.

## Alcance
- 2 cámaras virtuales/mock obligatorias para pruebas repetibles.
- Validación en al menos 1 cámara física.
- Persistencia de resultados y publicación en event-gateway.

## Criterios de aceptación
- [ ] Flujo E2E pasa en 2 fuentes virtuales sin pasos manuales.
- [ ] Flujo E2E pasa en al menos 1 cámara física.
- [ ] Admin/Portal muestran eventos realtime de detección.
- [ ] Evidencias mínimas guardadas por job.
MD

cat >/tmp/epic3.md <<'MD'
## Objetivo
Notificar incidentes y detecciones relevantes por Telegram para piloto.

## Alcance
- Integración bot Telegram.
- Formato mínimo de mensaje con tenant/cámara/timestamp y enlace a evidencia.
- Reintento básico en fallos transitorios.

## Criterios de aceptación
- [ ] Evento de incidente dispara mensaje Telegram.
- [ ] Mensaje incluye contexto operativo mínimo.
- [ ] Se registra éxito/falla de entrega para auditoría.
MD

cat >/tmp/epic4.md <<'MD'
## Objetivo
Tener smoke matrix por plano para validar rápido antes de cada demo/piloto.

## Alcance
- Control-plane, data-plane, event-plane, detection-plane.
- Checklist manual + smoke automatizado básico.
- Criterios Go/No-Go de piloto.

## Criterios de aceptación
- [ ] Existe checklist ejecutable en < 60 min.
- [ ] Smoke automatizado corre en CI o local reproducible.
- [ ] Definidos umbrales mínimos de aceptación para piloto.
MD

cat >/tmp/taskA1.md <<'MD'
## Objetivo
Implementar perfil on-prem y local con configuración clara.

## Aceptación
- [ ] `dev:stack:up` funciona en ambos perfiles.
- [ ] Health checks de API/stream/event responden.
MD

cat >/tmp/taskA2.md <<'MD'
## Objetivo
Configurar Cloudflare Tunnel para publicar servicios del piloto.

## Aceptación
- [ ] Admin y Portal accesibles por dominio.
- [ ] API y Event Gateway responden por dominio.
- [ ] WS y SSE funcionan sobre túnel.
MD

cat >/tmp/taskB1.md <<'MD'
## Objetivo
Construir harness de 2 cámaras virtuales/mock para pruebas repetibles.

## Aceptación
- [ ] 2 fuentes virtuales activas en entorno de prueba.
- [ ] Jobs de detección sobre ambas completan y publican eventos.
MD

cat >/tmp/taskB2.md <<'MD'
## Objetivo
Validar detección con cámaras físicas (subset inicial).

## Aceptación
- [ ] 1 cámara física validada E2E.
- [ ] Evento visible en realtime + incidente persistido.
MD

cat >/tmp/taskC1.md <<'MD'
## Objetivo
Integrar Telegram para notificaciones de incidentes.

## Aceptación
- [ ] Incidente real dispara mensaje Telegram.
- [ ] Trazabilidad de envío guardada en logs/auditoría.
MD

cat >/tmp/taskD1.md <<'MD'
## Objetivo
Definir y automatizar smoke cross-plane para piloto.

## Aceptación
- [ ] Smoke ejecutable en <= 60 min.
- [ ] Resultado PASS/FAIL claro con causas.
MD

create_issue "PILOT-01 Epic: Deploy local + on-prem + Cloudflare tunnel" "pilot,phase:deploy,infrastructure" /tmp/epic1.md
create_issue "PILOT-02 Epic: Detection E2E con 2 virtuales + físicas" "pilot,phase:detection,detection,api" /tmp/epic2.md
create_issue "PILOT-03 Epic: Telegram alerting para incidentes" "pilot,phase:messaging,integration,api" /tmp/epic3.md
create_issue "PILOT-04 Epic: Smoke matrix por plano + Go/No-Go" "pilot,phase:qa,testing" /tmp/epic4.md

create_issue "PILOT-A1: Perfil de despliegue dual (local/on-prem)" "pilot,phase:deploy,infrastructure" /tmp/taskA1.md
create_issue "PILOT-A2: Publicación por Cloudflare Tunnel" "pilot,phase:deploy,infrastructure,security" /tmp/taskA2.md
create_issue "PILOT-B1: Harness de 2 cámaras virtuales/mock" "pilot,phase:detection,detection,testing" /tmp/taskB1.md
create_issue "PILOT-B2: Validación con cámara física (subset inicial)" "pilot,phase:detection,detection" /tmp/taskB2.md
create_issue "PILOT-C1: Integración Telegram incidentes" "pilot,phase:messaging,integration,api" /tmp/taskC1.md
create_issue "PILOT-D1: Smoke cross-plane automatizado" "pilot,phase:qa,testing" /tmp/taskD1.md

retry gh issue list --repo "$REPO" --state open --limit 200 --search "PILOT-"
