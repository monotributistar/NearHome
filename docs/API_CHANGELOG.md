# API Changelog

## 2026-02-24 - v1.2.0

### Added

- NH-011: soporte de correlación por request:
  - Header opcional de entrada `X-Request-Id`.
  - Header de salida `x-request-id` en todas las respuestas.
  - Logging estructurado `request.summary`.
- NH-013: compatibilidad de rutas con prefijo `/v1/*` sin romper rutas actuales.
- NH-012: endpoint de readiness con check de DB:
  - `GET /readiness` devuelve `200` (`db=up`) o `503` (`db=down`).
- NH-016: auditoría básica de acciones críticas:
  - `GET /audit-logs` (tenant-scoped, solo `tenant_admin`).
  - registro de acciones en cámaras y suscripciones.
- NH-029: administración completa de tenants:
  - `DELETE /tenants/:id` con soft delete.
  - tenants eliminados se excluyen de `/auth/me` y `/tenants`.
- NH-031: integración inicial con data-plane (`stream-gateway`):
  - `POST /cameras/:id/stream-token` puede devolver `playbackUrl`.
  - provision/deprovision best-effort hacia `STREAM_GATEWAY_URL`.
- NH-030: validación multi-tenant de monitor:
  - cobertura API y E2E de visibilidad de cámaras por tenant seleccionado.
- NH-028: ciclo de vida de sesiones de stream:
  - `GET /stream-sessions`
  - `GET /stream-sessions/:id`
  - `POST /stream-sessions/:id/activate`
  - `POST /stream-sessions/:id/end`
  - `POST /cameras/:id/stream-token` ahora devuelve también `session`.

### Changed

- `POST /cameras/:id/stream-token`:
  - Antes: `{ token, expiresAt }`
  - Ahora: `{ token, expiresAt, session }`

### Compatibility

- Compatibilidad backward preservada:
  - Rutas legacy sin prefijo (`/auth/*`, `/cameras/*`, etc.) siguen activas.
  - Campo `token` y `expiresAt` se mantiene en stream-token.

### Notes

- `/v1` es alias de compatibilidad actual; la migración de fronts puede hacerse incrementalmente.
- `READINESS_FORCE_FAIL=1` está disponible para testear fallback de readiness en entorno local.
