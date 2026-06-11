# Runbook: publicar openBalena con Cloudflare Tunnel + varios clientes BalenaOS

Fecha: 2026-05-04

## Objetivo
Publicar openBalena de forma segura para administrar multiples dispositivos BalenaOS, minimizando superficie expuesta.

## Decision de arquitectura
- Publicar por Cloudflare Tunnel:
  - `api` (openBalena API)
  - `registry` (openBalena registry)
- Exponer de forma directa (IP publica + firewall) el endpoint `vpn`.

Razon operativa:
- El control-plane HTTP funciona muy bien por tunnel.
- El plano VPN de dispositivos requiere conectividad de red mas sensible; para flotas de varios clientes es mas estable mantenerlo con exposicion directa y reglas estrictas.

## Prerrequisitos
- Dominio en Cloudflare.
- Host Linux con Docker/Compose.
- `infra/openbalena/.env` completo.
- Tunnnel token de Cloudflare (`CLOUDFLARE_TUNNEL_TOKEN`).

## Implementacion

### 1) Configurar variables
```bash
cp infra/openbalena/.env.example infra/openbalena/.env
```

Definir al menos:
- `API_HOST`, `BALENA_API_HOST` (hostname API que vera balenaOS)
- `VPN_HOST`, `BALENA_VPN_HOST` (hostname VPN publico)
- `OPENBALENA_API_HOSTNAME` (ej `api.ob.midominio.com`)
- `OPENBALENA_REGISTRY_HOSTNAME` (ej `registry.ob.midominio.com`)
- `OPENBALENA_VPN_HOSTNAME` (ej `vpn.ob.midominio.com`)
- `CLOUDFLARE_TUNNEL_TOKEN`

### 2) DNS
- `api.ob.midominio.com` por Cloudflare Tunnel.
- `registry.ob.midominio.com` por Cloudflare Tunnel.
- `vpn.ob.midominio.com` apuntando al servidor openBalena (A/AAAA directo).

### 3) Reglas de firewall
- Abrir minimo:
  - `443/tcp` para `vpn`
  - `30000-40000/udp` para sesiones de dispositivos
- Cerrar exposicion publica de `api` y `registry` si quedan solo por tunnel.

### 4) Levantar stack
```bash
bash scripts/openbalena/stack-up.sh tunnel
```

## Plan de pruebas

### Smoke de infraestructura
```bash
docker compose --env-file infra/openbalena/.env -f infra/openbalena/docker-compose.yml -f infra/openbalena/docker-compose.cloudflare-tunnel.yml ps
bash scripts/openbalena/verify-tunnel.sh
```

Criterios de exito:
- `cloudflared` en `running`.
- `https://$OPENBALENA_API_HOSTNAME/health` responde 200.
- `https://$OPENBALENA_REGISTRY_HOSTNAME/v2/` responde 200 o 401.
- `OPENBALENA_VPN_HOSTNAME` resuelve por DNS.

### Smoke funcional con BalenaOS (varios clientes)
1. Crear 2-3 fleets (por cliente) en openBalena.
2. Provisionar 1+ dispositivo por fleet con su `provisioningApiKey`.
3. Validar para cada dispositivo:
- aparece online en dashboard
- recibe release
- reporta heartbeat estable por 15 min

Criterio de exito multi-cliente:
- onboarding simultaneo de al menos 3 dispositivos en 2 fleets sin desconexiones recurrentes.

## Operacion diaria
- Ver logs tunnel:
```bash
docker compose --env-file infra/openbalena/.env -f infra/openbalena/docker-compose.yml -f infra/openbalena/docker-compose.cloudflare-tunnel.yml logs -f cloudflared
```
- Reiniciar solo tunnel:
```bash
docker compose --env-file infra/openbalena/.env -f infra/openbalena/docker-compose.yml -f infra/openbalena/docker-compose.cloudflare-tunnel.yml restart cloudflared
```
- Bajar stack:
```bash
bash scripts/openbalena/stack-down.sh tunnel
```

## Riesgos y mitigaciones
- Riesgo: caida tunnel deja fuera API/registry.
  - Mitigacion: monitoreo de `cloudflared` + reinicio automatico.
- Riesgo: saturacion UDP con muchas altas simultaneas.
  - Mitigacion: pruebas de carga progresivas por lote de dispositivos.
- Riesgo: divergencia entre hostnames de provision y DNS real.
  - Mitigacion: checklist previa por entorno y prueba de 1 dispositivo canario.

## Checklist de salida a piloto
- [ ] API y registry accesibles solo via Cloudflare.
- [ ] VPN accesible por hostname publico.
- [ ] 3+ dispositivos de 2+ clientes conectan y reciben despliegue.
- [ ] Runbook y variables versionadas en repo.
