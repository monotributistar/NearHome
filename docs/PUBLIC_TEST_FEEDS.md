# Feeds públicos para pruebas (NearHome)

Esta lista prioriza feeds **abiertos** y fáciles de probar en desarrollo.
Se incluyen:

- feeds HLS públicos verificados desde este entorno
- feeds RTSP públicos de referencia (pueden estar bloqueados por red/firewall)

Fecha de verificación base: **2026-03-19**.

## Catálogo rápido

El catálogo machine-readable está en:

- `/Users/monotributistar/SOURCES/NearHome/infra/public-test-feeds.json`

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
- Algunos feeds son de demo/video de prueba (no CCTV real), útiles para validar pipeline.
- Verificá términos de uso del proveedor antes de usar en entornos productivos.
