# NearHome Ansible

Deploy reproducible para entorno on-prem con soporte de vault local/remoto.

## Estructura
- `inventory/lab/hosts.yml`: inventario de hosts.
- `group_vars/all.yml`: defaults globales.
- `playbooks/deploy.yml`: prepara host + deploy stack + smoke.
- `playbooks/smoke.yml`: smoke independiente.
- `roles/*`: responsabilidades por capa.

## Prerrequisitos del controlador Ansible
- Ansible instalado en la máquina desde la que ejecutás.
- Acceso SSH al host objetivo.
- Permisos `become` en el host.
- Colecciones requeridas:
```bash
ansible-galaxy collection install -r ansible/requirements.yml
```

## Variables clave
- `vault_mode`: `local` o `remote`.
- `nearhome_project_dir`: path del repo en host remoto.
- `nearhome_repo_url` / `nearhome_repo_version`: fuente del código.
- `vault_manage_device`: por defecto `false` (no formatea disco).
- `vault_device`, `vault_mount_point`, `vault_fs_type`.
- `nfs_server`, `nfs_export_path`, `onprem_vault_remote_path`.
- `detection_deploy_api_url`, `detection_deploy_admin_email`, `detection_deploy_admin_password`: credenciales para exportar nodos generados desde control-plane.
- `detection_stack_sync_command`: comando base para `POST /ops/nodes/stack-sync-detection` desde `api`.
- `detection_stack_sync_timeout_ms`, `detection_stack_sync_max_retries`, `detection_stack_sync_retry_delay_ms`: hardening del loop de stack sync (timeout/reintentos).

## Uso
1. Editar inventario:
```bash
ansible/inventory/lab/hosts.yml
```

2. Ajustar variables:
```bash
ansible/group_vars/all.yml
```

3. Deploy:
```bash
ansible-playbook -i ansible/inventory/lab/hosts.yml ansible/playbooks/deploy.yml
```

El role `nearhome_stack` ahora ejecuta sincronización de detección antes del deploy final:
- arranque base sin nodos estáticos
- export de `infra/docker-compose.detection.generated.yml`
- re-aplicación del stack con nodos generados

El role `smoke_checks` también valida la conexión `admin/api` para stack sync:
- `pnpm pilot:smoke:stack-sync-api` (default `dry-run`)

4. Smoke separado:
```bash
ansible-playbook -i ansible/inventory/lab/hosts.yml ansible/playbooks/smoke.yml
```

## Nota de seguridad
- Cargar secretos reales mediante `ansible-vault` o variables externas.
- No commitear secretos productivos en texto plano.
