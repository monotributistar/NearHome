---
tags: [nearhome, validation, runbook]
status: active
---

# Validation Checklist

## Checkout limpio

- [ ] `git status --short` solo muestra cambios intencionales.
- [ ] `pnpm install` termina correctamente.
- [ ] Templates `.env.example` no contienen secretos reales.
- [ ] `git diff --check` no informa errores.

## API y edge

- [ ] `pnpm --filter @app/api typecheck`.
- [ ] `pnpm --filter @app/api test:edge`.
- [ ] `python3 -m pytest edge-gateway/discovery-agent/tests -q`.
- [ ] Heartbeat sin token retorna 401.
- [ ] Token de otro gateway retorna 403.

## Compose

- [ ] `docker compose -f infra/docker-compose.yml config`.
- [ ] `docker compose -f infra/docker-compose.poc.yml config`.
- [ ] Health endpoints responden.
- [ ] Logs no contienen tokens, passwords o private keys.

## GPU

- [ ] `nvidia-smi` detecta RTX 3070 y VRAM real.
- [ ] Docker ejecuta un contenedor con `--gpus all`.
- [ ] Compose GPU valida con variables obligatorias.
- [ ] Nodo registra heartbeat en inference bridge.
- [ ] Benchmark queda registrado, no inferido de especificaciones teoricas.

## Edge real

- [ ] Claves WireGuard persistentes.
- [ ] Control VPN sigue online si cae WireGuard.
- [ ] WireGuard sigue transportando video si cae API.
- [ ] Hub puede abrir RTSP; otro edge no puede.
- [ ] Reboot recupera ambos planos sin reprovision manual.
