# Storage Vaults (Local / LAN / VPN)

Fecha de corte: `2026-03-05`

## Objetivo

Delegar almacenamiento de video a nodos filesystem (locales o remotos montados por LAN/VPN) con:

- ruteo por `vault`,
- retención por cámara según entitlements (`retentionDays`),
- base preparada para escalar a múltiples vaults.

## Cómo funciona hoy

1. API emite `POST /provision` hacia `stream-gateway` incluyendo:
   - `planCode`
   - `retentionDays` (desde entitlements)
2. Stream-gateway selecciona vault:
   - `storageVaultId` explícito (si viene),
   - si no, mapping por plan (`STREAM_STORAGE_PLAN_VAULT_MAP_JSON`),
   - si no, vault default (`STREAM_STORAGE_DEFAULT_VAULT_ID`).
3. Cada stream guarda segmentos en:
   - `<vault.basePath>/<tenantId>/<cameraId>/...`
4. El loop de retención elimina por cámara usando `retentionDays` del stream.
5. Si un vault supera `STREAM_RETENTION_MAX_DISK_USAGE_PCT`, se aplica limpieza por presión hasta `STREAM_RETENTION_TARGET_DISK_USAGE_PCT`.

## Vault único (modo básico recomendado)

Configurar en `infra/.env.onprem`:

```env
STREAM_STORAGE_DEFAULT_VAULT_ID=vault-main
STREAM_STORAGE_VAULTS_JSON=[{"id":"vault-main","basePath":"/data/storage","description":"single vault"}]
STREAM_STORAGE_PLAN_VAULT_MAP_JSON={}
```

Esto deja todo en un solo nodo de storage, pero con contrato listo para escalar.

## Delegar storage a otro nodo (LAN/VPN)

El vault es filesystem. Para delegar:

1. Montar filesystem remoto dentro del host de `stream-gateway`:
   - NFS/CIFS/SSHFS/WireGuard+NFS, etc.
2. Exponer ese mount al contenedor (en compose base ya existe `/data/storage`).
3. Apuntar el vault a ese path montado.

Ejemplo conceptual:

- host monta `10.0.0.20:/exports/nearhome` en `/mnt/nearhome-vault`
- contenedor recibe ese mount como `/data/storage`
- `vault-main.basePath=/data/storage`

Perfil listo para docker compose:

- env: `infra/.env.onprem.remote`
- compose override: `infra/docker-compose.onprem.vault-remote.yml`
- comandos:
  - `pnpm pilot:stack:up:onprem:remote`
  - `pnpm pilot:stack:down:onprem:remote`

## Escalado próximo a múltiples vaults

Ejemplo:

```env
STREAM_STORAGE_DEFAULT_VAULT_ID=vault-main
STREAM_STORAGE_VAULTS_JSON=[{"id":"vault-main","basePath":"/data/storage/main"},{"id":"vault-enterprise","basePath":"/data/storage/enterprise"}]
STREAM_STORAGE_PLAN_VAULT_MAP_JSON={"starter":"vault-main","pro":"vault-main","enterprise":"vault-enterprise"}
```

Resultado:

- tenants `enterprise` escriben en `vault-enterprise`,
- resto en `vault-main`.

## Operación

- Estado operativo: `GET /health` -> `retention.vaults`, `retention.lastSummary`.
- Métricas: `GET /metrics`:
  - `nearhome_storage_retention_*`
  - `nearhome_storage_usage_*`
- Sweep manual: `POST /retention/sweep`.
- API runtime de vaults:
  - `GET /storage/vaults`
  - `POST /storage/vaults`
  - `PATCH /storage/vaults/:vaultId`
  - `DELETE /storage/vaults/:vaultId`
  - `POST /storage/vaults/:vaultId/check`
  - `GET /storage/plan-vault-map`
  - `PUT /storage/plan-vault-map`

## Notas de diseño

- En esta etapa el vault es filesystem; no hay object storage nativo aún.
- La selección de vault ocurre en provision y queda asociada al stream.
- El modelo soporta crecer a “vault policies” más finas (zona, tenant, cámara, SLA) sin romper contrato HTTP existente.
- Soporta clips por evento con ventanas `pre/post` (`POST /events/clip`) y playback por token.
