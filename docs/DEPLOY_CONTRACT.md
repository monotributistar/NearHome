# NearHome Deployment Contract

## 1. Objetivo
Definir el contrato operativo para despliegues reproducibles y testeables de NearHome en entornos on-prem.

## 2. Inputs obligatorios
- `environment`: identificador de entorno (`lab`, `staging`, `prod`).
- `vault_mode`: `local` o `remote`.
- `app_version`: versión/tag a desplegar.
- `nearhome_project_dir`: path absoluto del proyecto en el host.
- `secrets`: secretos de ejecución (mínimo: `STREAM_TOKEN_SECRET`, `EVENT_PUBLISH_SECRET`, `NODE_AUTH_JWT_SECRET`, `NODE_AUTH_ADMIN_SECRET`).

## 3. Invariantes de despliegue
- Los secretos compartidos deben estar alineados entre servicios:
  - `STREAM_TOKEN_SECRET` igual entre `api` y `stream-gateway`.
  - `EVENT_PUBLISH_SECRET` igual entre `api` y `event-gateway`.
- Se deben exponer y responder los puertos funcionales:
  - `3001`, `3010`, `3011`, `8072`, `8090`, `8091`, `8092`, `7233`, `8088`, `6379`.
- `vault_mode=local`:
  - El storage principal de stream apunta a path local (`/data/vault00` o el definido por variable).
- `vault_mode=remote`:
  - El storage principal de stream apunta a mount remoto (`/data/storage-remote` o el definido por variable).
  - El mount remoto debe estar accesible antes de `stack up`.

## 4. Secuencia obligatoria de deploy
1. Validación de prerequisitos del host.
2. Preparación de storage (local o remoto).
3. Render de `.env` on-prem correspondiente.
4. Levantar stack (`pnpm pilot:stack:up:onprem` o `pnpm pilot:stack:up:onprem:remote`).
5. Verificación funcional (`pnpm pilot:smoke`).

## 5. Criterio de éxito
- `docker ps` muestra todos los servicios principales `Up`.
- `pnpm pilot:smoke` finaliza en `Smoke planes PASS`.
- Test mínimo de regresión:
  - `pnpm --filter @app/api test`
  - `pnpm --filter @app/stream-gateway test`

## 6. Criterio de fallo
Se considera despliegue fallido si se cumple cualquiera de estas condiciones:
- No se puede montar el vault requerido por el modo.
- Stack no converge (`docker compose up` con error).
- Falla `pilot:smoke`.

## 7. Rollback
- Re-ejecutar deploy con `app_version` anterior estable.
- Si aplica cambio de modo, volver al `vault_mode` previo.
- Confirmar estado con `pnpm pilot:smoke`.

## 8. Seguridad y operación
- Nunca hardcodear secretos en playbooks; usar `ansible-vault` o variables inyectadas.
- El manejo de disco (`mkfs`) está deshabilitado por defecto; sólo se habilita explícitamente.
- Toda ejecución debe dejar traza en logs de Ansible y salida de smoke.
