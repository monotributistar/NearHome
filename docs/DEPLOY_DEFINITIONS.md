# NearHome Deployment Definitions

## 1. Alcance
Definiciones operativas para administrar despliegues NearHome con Ansible en on-prem.

## 2. Topología recomendada (lab)
- Host físico principal:
  - Docker + stack NearHome.
  - Nodo de inferencia con CUDA (sin virtualizar GPU).
- Vault:
  - `local`: partición dedicada montada en `/data/vault00`.
  - `remote`: export NFS desde host/VM de storage, montado en `/data/storage-remote`.

## 3. Modos de storage
- `vault_mode=local`
  - Compose mode: `onprem`
  - `STREAM_STORAGE_DEFAULT_VAULT_ID=vault-main`
  - `STREAM_STORAGE_VAULTS_JSON=[{"id":"vault-main","basePath":"/data/vault00"}]`
- `vault_mode=remote`
  - Compose mode: `onprem-remote`
  - `ONPREM_VAULT_REMOTE_PATH=/data/storage-remote`
  - `STREAM_STORAGE_DEFAULT_VAULT_ID=vault-remote`
  - `STREAM_STORAGE_VAULTS_JSON=[{"id":"vault-remote","basePath":"/data/storage-remote"}]`

## 4. Variables de despliegue (Ansible)
- `vault_mode`: `local|remote`.
- `nearhome_project_dir`: directorio de trabajo del repo.
- `nearhome_repo_url`: origen git para bootstrap del repo.
- `nearhome_repo_version`: branch/tag a desplegar.
- `vault_manage_device`: `false` por defecto (evita formateo accidental).
- `vault_device`: dispositivo de bloque (`/dev/sdXn`).
- `vault_fs_type`: `xfs` recomendado para video.
- `vault_mount_point`: mount local del vault (`/data/vault00`).
- `nfs_server` / `nfs_export_path`: origen remoto para modo `remote`.
- `onprem_vault_remote_path`: mountpoint local del NFS.

## 5. Estructura lógica del vault
- Root: `/data/vault00` (local) o `/data/storage-remote` (remote).
- Organización sugerida:
  - `<tenantId>/<cameraId>/<yyyy>/<mm>/<dd>/`
- Política de housekeeping:
  - Retención temporal (`STREAM_RETENTION_DAYS`).
  - Sweep periódico (`STREAM_RETENTION_SWEEP_MS`).
  - Límite de ocupación (`STREAM_RETENTION_MAX_DISK_USAGE_PCT`).

## 6. Pipeline de deploy
1. `base`: paquetes base (`git`, `ripgrep`, `curl`, etc.).
2. `docker`: Docker engine + compose plugin + servicio.
3. `vault_local` o `vault_remote_nfs` según `vault_mode`.
4. `nearhome_stack`: checkout repo, `pnpm i`, render `.env`, stack up.
5. `smoke_checks`: `pnpm pilot:smoke` con reintentos.

## 7. Tests de aceptación
- Salud de servicios por plano:
  - control: `api /health`
  - data: `stream /health`
  - event: `event /health`
  - detection: `bridge/yolo/mediapipe/dispatcher /health`
- Realtime event replay operativo.
- Temporal UI accesible.

## 8. Operación diaria
- Deploy:
  - `ansible-playbook -i ansible/inventory/lab/hosts.yml ansible/playbooks/deploy.yml`
- Smoke:
  - `ansible-playbook -i ansible/inventory/lab/hosts.yml ansible/playbooks/smoke.yml`
- Cambio de modo local/remote:
  - cambiar `vault_mode` en inventory/group_vars y re-ejecutar deploy.
