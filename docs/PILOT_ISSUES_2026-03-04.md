# Pilot Issues Pack (2026-03-04)

Este documento define los issues para arrancar piloto con foco en detección visual, Telegram y despliegue on-prem + Cloudflare Tunnel.

## Epics

1. `PILOT-01 Epic: Deploy local + on-prem + Cloudflare tunnel`
2. `PILOT-02 Epic: Detection E2E con 2 virtuales + físicas`
3. `PILOT-03 Epic: Telegram alerting para incidentes`
4. `PILOT-04 Epic: Smoke matrix por plano + Go/No-Go`

## Tareas por epic

### PILOT-01

- `PILOT-A1: Perfil de despliegue dual (local/on-prem)`
- `PILOT-A2: Publicación por Cloudflare Tunnel`

### PILOT-02

- `PILOT-B1: Harness de 2 cámaras virtuales/mock`
- `PILOT-B2: Validación con cámara física (subset inicial)`

### PILOT-03

- `PILOT-C1: Integración Telegram incidentes`

### PILOT-04

- `PILOT-D1: Smoke cross-plane automatizado`

## Labels sugeridos

- `pilot`
- `phase:deploy`
- `phase:detection`
- `phase:messaging`
- `phase:qa`
- `phase:runbook`

## Milestones sugeridos

- `Fase A - Hardening de plataforma`
- `Fase B - Ingesta y deteccion operativa`
- `Fase C - Incidencias y mensajeria`
- `Fase D - Servicios cliente y dashboard`
- `Fase E - Reconocimiento facial`

## Script de creación automática

Ejecutar:

```bash
bash scripts/github/create-pilot-issues.sh
```

Notas:
- El script es idempotente a nivel práctico: si labels existen, continúa.
- Requiere conectividad estable a `api.github.com`.
