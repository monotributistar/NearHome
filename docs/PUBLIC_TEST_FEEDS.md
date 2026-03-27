# Feeds públicos para pruebas (NearHome)

Esta lista prioriza feeds **abiertos** y fáciles de probar en desarrollo.
Se incluyen:

- **70 cámaras públicas** (WSDOT) en formato snapshot JPEG
- feeds HLS públicos de fallback para pipelines de video continuo

Fecha de verificación base: **2026-03-22**.

## Catálogo rápido

El catálogo machine-readable está en:

- `/Users/monotributistar/SOURCES/NearHome/infra/public-test-feeds.json`

Estado de salud más reciente del catálogo:

- `/Users/monotributistar/SOURCES/NearHome/docs/reports/public-feeds-health-2026-03-22.json`

## Uso con harness de piloto

Podés copiar:

- `/Users/monotributistar/SOURCES/NearHome/infra/.env.pilot.cameras.public.example`

y usar:

```bash
cp infra/.env.pilot.cameras.public.example infra/.env.pilot.cameras
pnpm pilot:harness
```

## Notas importantes

- Estos endpoints son externos y pueden cambiar sin aviso.
- Las cámaras WSDOT son snapshots (`.jpg`), no RTSP/HLS.
- Algunos feeds son de demo/video de prueba (no CCTV real), útiles para validar pipeline continuo.
- Verificá términos de uso del proveedor antes de usar en entornos productivos.
