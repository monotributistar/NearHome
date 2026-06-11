# openbalena Infrastructure Setup

This directory contains the Docker Compose configuration for deploying openbalena, the self-hosted version of balenaCloud.

## Prerequisites

- Docker Engine 24.0+
- Docker Compose v2.20+
- 4GB RAM minimum (8GB recommended for production)
- 50GB disk space minimum
- Domain name configured for DNS

## Quick Start

### 1. Configure Environment

```bash
cd infra/openbalena
cp .env.example .env
# Edit .env with your configuration
```

### 2. Start Services

```bash
docker-compose up -d
```

Or with the helper script:

```bash
bash scripts/openbalena/stack-up.sh base
```

### 3. Verify Services

```bash
docker-compose ps
docker-compose logs -f api
```

### 4. Configure DNS

Point your domain to the server:

| Record Type | Name            | Value          |
| ----------- | --------------- | -------------- |
| A           | api.balena      | YOUR_SERVER_IP |
| A           | vpn.balena      | YOUR_SERVER_IP |
| A           | registry.balena | YOUR_SERVER_IP |

## Cloudflare Tunnel (recommended for API + Registry)

Use Cloudflare Tunnel to publish HTTP services (`api`, `registry`) without exposing origin ports.

Important:

- Keep `vpn` exposed directly on your server/public IP for device onboarding stability.
- openBalena VPN device traffic uses port ranges that are better handled with direct host networking/firewall controls.

### 1. Configure environment

```bash
cp infra/openbalena/.env.example infra/openbalena/.env
```

Set at least:

- `OPENBALENA_API_HOSTNAME`
- `OPENBALENA_REGISTRY_HOSTNAME`
- `OPENBALENA_VPN_HOSTNAME`
- `CLOUDFLARE_TUNNEL_TOKEN`

### 2. Configure tunnel routes in Cloudflare

- `api.<your-domain>` -> `http://api:3000`
- `registry.<your-domain>` -> `http://registry:80`

Reference template: `infra/openbalena/cloudflared-config.example.yml`

### 3. Start with tunnel profile

```bash
bash scripts/openbalena/stack-up.sh tunnel
```

### 4. Verify end-to-end

```bash
bash scripts/openbalena/verify-tunnel.sh
```

### 5. Access openbalena

- API: http://api.balena:3000 (or your configured domain)
- MinIO Console: http://api.balena:9001

## Fleet Setup

### Creating a Fleet for Edge Gateways

After openbalena is running:

1. Access the openbalena API dashboard
2. Create a new fleet named "Edge Gateways"
3. Note the fleet UUID for device provisioning
4. Generate a provisioning API key

### Device Provisioning

To provision Raspberry Pi devices:

```bash
# Install balena CLI
npm install -g balena-cli

# Configure balena to use your openbalena
balena login --credentials --email admin@balena --password your_password
balena api-key create "Edge Gateway Key" --description "For edge gateway devices"
```

### Device Configuration

Create a `config.json` for your Raspberry Pi:

```json
{
  "wifi": {
    "ssid": "YourNetwork",
    "password": "YourPassword"
  },
  "applicationName": "Edge Gateways",
  "apiEndpoint": "https://api.balena/",
  "provisioningApiKey": "your_provisioning_key"
}
```

For tunnel deployments, set hostnames matching your published endpoints and keep VPN endpoint public/reachable from devices.

Flash this config to the Raspberry Pi SD card using balenaEtcher with balenaOS.

## Services

| Service    | Port             | Description                    |
| ---------- | ---------------- | ------------------------------ |
| api        | 3000             | openbalena API server          |
| vpn        | 443, 30000-40000 | VPN for device connectivity    |
| registry   | 80               | Docker registry for containers |
| s3         | 9000             | MinIO S3 storage               |
| s3-console | 9001             | MinIO web console              |

## Backup & Recovery

### Backup Database

```bash
docker-compose exec db pg_dump -U openbalena openbalena > backup.sql
```

### Restore Database

```bash
docker-compose exec -T db psql -U openbalena openbalena < backup.sql
```

## Security Notes

1. Change all default passwords in `.env`
2. Use valid TLS certificates (configure haproxy in production)
3. Restrict API access by IP if needed
4. Enable firewall rules:

```bash
# Allow only necessary ports
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw allow 30000:40000/udp  # VPN
```

## Troubleshooting

### API not starting

Check logs: `docker-compose logs api`

Common issues:

- Database not ready: wait for db health check
- Invalid credentials: verify .env configuration

### Devices not connecting

Check VPN: `docker-compose logs vpn`

Common issues:

- Firewall blocking VPN ports
- DNS not resolving vpn.balena

## Next Steps

After Phase 1 is complete, proceed to Phase 2:

- Add EdgeGateway model to schema.prisma
- Create API endpoints for device registration

See: `docs/edge-gateway-api.md` for API documentation.
