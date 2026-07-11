---
tags: [nearhome, edge, raspberry-pi, setup]
status: draft
---

# Edge Node Setup

## Plataforma inicial

Raspberry Pi 4 o superior, Raspberry Pi OS Lite 64-bit y Docker Compose. BalenaOS
se evalua despues de demostrar el mismo stack en hardware.

## Interfaces esperadas

- Interfaz camera LAN: acceso al CIDR de camaras.
- Interfaz WAN: salida a internet.
- `wg0`: video plane hacia Linux box.
- Tailscale/Headscale: control plane hacia API.

## Provision

1. Instalar Docker, WireGuard y herramientas de diagnostico.
2. Generar clave WireGuard persistente con permisos `0600`.
3. Registrar gateway en `/api/v1/edge-gateways/register`.
4. Guardar `gatewayId` y `EDGE_GATEWAY_API_TOKEN` en secret storage.
5. Configurar control VPN.
6. Configurar peer WireGuard y CIDR de camaras no superpuesto.
7. Levantar discovery agent y router.
8. Validar heartbeat, discovery y RTSP desde el hub.

## Variables edge

- `BALENA_DEVICE_UUID`: actualmente funciona como ID de dispositivo; debe ser UUID.
- `EDGE_GATEWAY_API_TOKEN`: secreto devuelto al registrar.
- `API_BASE_URL`: endpoint API por control VPN.
- `CAMERA_SUBNET_CIDR`: LAN local de camaras.
- `INFRA_ALLOWED_CIDRS`: origenes hub permitidos.
- `CAMERA_IFACE`: interfaz LAN de camaras.
- `ROUTING_MODE`: `route` o `snat`.
- `WG_CONFIG_PATH`: archivo WireGuard montado read-only.

## Fuente tecnica

- [Edge SPEC](../sdd/edge-node/SPEC.md)
- [Edge DESIGN](../sdd/edge-node/DESIGN.md)
- [Edge TASKS](../sdd/edge-node/TASKS.md)
- [Edge API](../edge-gateway-api.md)
