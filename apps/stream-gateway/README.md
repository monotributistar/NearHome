# Stream Gateway (Data Plane MVP)

Servicio MVP para provisionar playback por cámara.

## Endpoints

- `POST /provision` `{ tenantId, cameraId, rtspUrl }`
- `POST /deprovision` `{ tenantId, cameraId }`
- `GET /health`
- `GET /health/:tenantId/:cameraId`
- `GET /metrics` (formato Prometheus)
- `GET /playback/:tenantId/:cameraId/index.m3u8?token=`
- `GET /playback/:tenantId/:cameraId/segment0.ts?token=`

## Notas

- En esta iteración genera un manifiesto/segmento mock para validar integración end-to-end.
- El token de playback es firmado (HMAC SHA-256) y valida `tenantId`, `cameraId`, firma y expiración.
- Worker interno de probes mock actualiza salud por stream (`online|degraded|offline`) cada `STREAM_PROBE_INTERVAL_MS`.
- `GET /health/:tenantId/:cameraId` devuelve `status` y `health` para sincronización en control-plane.
