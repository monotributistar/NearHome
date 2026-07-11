---
tags: [nearhome, credentials, environment, security]
status: active
---

# Credentials and Environment Variables

## Reglas

1. Los archivos `*.example` contienen placeholders, nunca valores reales.
2. Los secretos locales viven en `.env` ignorados por Git.
3. Las claves de dispositivo viven en volumen persistente o secret store.
4. Una clave privada nunca se pasa como argumento de CLI ni se imprime en logs.
5. Local demo y produccion usan secretos distintos.
6. Si un secreto fue versionado o compartido, se rota; borrarlo no alcanza.

## Generacion local

```bash
openssl rand -hex 32  # JWT_SECRET
openssl rand -hex 32  # CAMERA_CREDENTIALS_KEY
openssl rand -hex 32  # EVENT_PUBLISH_SECRET
openssl rand -hex 32  # NODE_AUTH_ADMIN_SECRET
openssl rand -hex 32  # NODE_AUTH_JWT_SECRET
```

WireGuard:

```bash
umask 077
wg genkey | sudo tee /etc/wireguard/private.key >/dev/null
sudo cat /etc/wireguard/private.key | wg pubkey
```

## Matriz por capa

| Variable/credencial      | Capa              | Secreto | Requerido local   | Origen                |
| ------------------------ | ----------------- | ------- | ----------------- | --------------------- |
| `JWT_SECRET`             | API               | si      | si                | generar               |
| `CAMERA_CREDENTIALS_KEY` | API               | si      | si para passwords | generar               |
| `EVENT_PUBLISH_SECRET`   | events/detector   | si      | si                | generar               |
| `STREAM_TOKEN_SECRET`    | stream            | si      | si                | generar               |
| `NODE_AUTH_ADMIN_SECRET` | bridge/nodes      | si      | si                | generar               |
| `NODE_AUTH_JWT_SECRET`   | inference bridge  | si      | si                | generar               |
| `NODE_ENROLLMENT_TOKEN`  | GPU node          | si      | segun enrollment  | API/bridge            |
| `HF_TOKEN`               | inference externa | si      | no                | Hugging Face          |
| `EDGE_GATEWAY_API_TOKEN` | edge              | si      | solo edge         | respuesta de registro |
| WireGuard private key    | video VPN         | si      | solo lab VPN      | generar por nodo      |
| WireGuard public key     | video VPN         | no      | solo lab VPN      | derivar               |
| Headscale auth key       | control VPN       | si      | solo lab VPN      | Headscale             |
| `WIFI_PASSWORD`          | provisioning      | si      | no en Docker      | sitio/operador        |
| credencial RTSP          | camera            | si      | segun camara      | dispositivo           |

## Archivos y responsabilidades

| Archivo template                       | Uso                                       |
| -------------------------------------- | ----------------------------------------- |
| `.env.example`                         | raiz y defaults generales                 |
| `apps/api/.env.example`                | API y SQLite local                        |
| `apps/admin/.env.example`              | URL API/admin                             |
| `apps/portal/.env.example`             | URL API/portal                            |
| `infra/.env.local.example`             | stack local                               |
| `infra/.env.onprem.example`            | hub on-premise                            |
| `infra/docker-compose.gpu.env.example` | Linux box RTX 3070                        |
| `infra/openbalena/.env.example`        | openBalena, no requerido para PoC inicial |

## Credenciales demo

El seed crea usuarios locales con password demo. Solo son validos para desarrollo
y tests. Nunca desplegar ese seed o password en una red accesible publicamente.

## Rotacion pendiente

La clave WireGuard que existia antes de Fase 0 debe reemplazarse en cualquier
host donde haya sido instalada y en todos sus peers.
