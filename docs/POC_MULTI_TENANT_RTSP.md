# POC Multi-Tenant RTSP — Milestone 1

Date: 2026-06-10
Status: In progress
Repo: /Users/monotributistar/SOURCES/NearHome
Branch: claude/deployments-fleet-manifest

## Goal

Validate that NearHome's stream-gateway correctly handles multiple tenants ingesting RTSP streams simultaneously, with strict isolation: Tenant A cannot access Tenant B's streams, and vice versa.

## Topology

```
┌─ Tenant A (TENANT_A_ID) ──────────────────────────────┐
│                                                         │
│  Camera 1: Alpha-Entrada                                │
│    rtsp://localhost:8554/alpha-entrada                  │
│    1280x720, motion pattern                             │
│                                                         │
│  Camera 2: Alpha-Patio                                  │
│    rtsp://localhost:8554/alpha-patio                    │
│    640x480, static                                      │
│                                                         │
└─────────────────────────────────────────────────────────┘

┌─ Tenant B (TENANT_B_ID) ──────────────────────────────┐
│                                                         │
│  Camera 1: Bravo-Pasillo                                │
│    rtsp://localhost:8554/bravo-pasillo                  │
│    640x480, motion pattern                              │
│                                                         │
└─────────────────────────────────────────────────────────┘

                    Stream Gateway (:3010)
                         │
              ┌──────────┴──────────┐
              │                     │
         Tenant A token       Tenant B token
         → Cam A1 OK           → Cam B1 OK
         → Cam B1 BLOCKED      → Cam A1 BLOCKED
```

## Acceptance Criteria

- [x] Two tenants created with non-overlapping camera sets
- [x] 3 cameras total across 2 tenants (2+1)
- [x] Stream gateway provisions all 3 RTSP streams
- [x] Each tenant can generate stream tokens for their own cameras
- [x] Tenant A's token is REJECTED when accessing Tenant B's stream
- [x] Tenant B's token is REJECTED when accessing Tenant A's stream
- [x] Camera listing per tenant shows only own cameras (no cross-tenant leak)
- [x] Both tenants can stream simultaneously without collision
- [x] Malformed/invalid token correctly rejected

## Scripts Created

### 1. `scripts/pilot/seed-multi-tenant.sh`
Creates tenants, cameras, provisions RTSP streams, validates isolation.

**Usage:**
```bash
# With stack already running
bash scripts/pilot/seed-multi-tenant.sh

# With clean slate
bash scripts/pilot/seed-multi-tenant.sh --clean
```

**What it does:**
1. Waits for API + Stream gateway health
2. Logs in as admin (admin@nearhome.dev)
3. Creates Tenant A and Tenant B
4. Creates 2 cameras for Tenant A, 1 camera for Tenant B
5. Validates cameras (simulated pass)
6. Provisions all 3 RTSP streams via stream-gateway
7. Checks stream health for all cameras
8. Validates cross-tenant isolation (camera read, camera listing)
9. Saves state to `/tmp/nearhome-poc-multitenant-state.json`

**Environment variables:**
| Variable | Default |
|----------|---------|
| API_URL | http://localhost:3001 |
| STREAM_URL | http://localhost:3010 |
| ADMIN_EMAIL | admin@nearhome.dev |
| ADMIN_PASSWORD | demo1234 |
| TENANT_A_NAME | POC Tenant Alpha |
| TENANT_B_NAME | POC Tenant Bravo |
| CAM_A1_RTSP | rtsp://localhost:8554/alpha-entrada |
| CAM_A2_RTSP | rtsp://localhost:8554/alpha-patio |
| CAM_B1_RTSP | rtsp://localhost:8554/bravo-pasillo |

### 2. `scripts/pilot/rtsp-simulator.sh`
Launches synthetic RTSP test streams via ffmpeg + MediaMTX.

**Usage:**
```bash
bash scripts/pilot/rtsp-simulator.sh start    # Start all streams
bash scripts/pilot/rtsp-simulator.sh stop     # Stop all streams
bash scripts/pilot/rtsp-simulator.sh status   # Check status
```

**Streams (matching seed defaults):**
| Path | Label | Resolution | Pattern |
|------|-------|------------|---------|
| /alpha-entrada | Main Entrance | 1280x720 | motion (moving ball) |
| /alpha-patio | Backyard | 640x480 | static |
| /bravo-pasillo | Hallway | 640x480 | motion (moving textures) |

Each stream includes:
- Video: testsrc + label overlay + pattern filter
- Audio: 440Hz sine tone, 16kHz mono AAC
- Encoded as H.264 baseline, 15fps, ultrafast preset — minimal CPU

**Requirements:**
- ffmpeg (brew install ffmpeg)
- MediaMTX (auto-started via Docker or local binary)
  - Docker: `bluenviron/mediamtx:latest`
  - Binary: `brew install bluenviron/tap/mediamtx`

### 3. `scripts/pilot/smoke-multi-tenant-rtsp.sh`
End-to-end validation of multi-tenant RTSP isolation.

**Usage:**
```bash
# After seed-multi-tenant.sh
bash scripts/pilot/smoke-multi-tenant-rtsp.sh
```

**7 test cases:**
1. Admin authentication
2. Stream token generation for both tenants
3. Cross-tenant token isolation (both directions)
4. Camera listing isolation (no leaks)
5. Concurrent stream access (both tenants)
6. Stream health checks
7. Malformed token rejection

**Exit code:** 0 if all pass, non-zero if any fail.

## Full Pipeline (Milestone 1)

```bash
# 1. Start the NearHome stack
pnpm pilot:stack:up:local

# 2. Start RTSP simulator (synthetic cameras)
bash scripts/pilot/rtsp-simulator.sh start

# 3. Seed multi-tenant data + provision streams
bash scripts/pilot/seed-multi-tenant.sh

# 4. Run smoke validation
bash scripts/pilot/smoke-multi-tenant-rtsp.sh

# 5. (Optional) Monitor streams
curl http://localhost:3010/health/TENANT_A_ID/CAM_A1_ID | jq .
curl http://localhost:3010/metrics | jq .nearhome_streams_total

# 6. Cleanup
bash scripts/pilot/rtsp-simulator.sh stop
pnpm pilot:stack:down:local
```

## State File Format (`/tmp/nearhome-poc-multitenant-state.json`)

```json
{
  "tenants": {
    "a": {
      "id": "...",
      "name": "POC Tenant Alpha",
      "cameras": [
        { "id": "...", "name": "Alpha-Entrada", "rtspUrl": "rtsp://..." },
        { "id": "...", "name": "Alpha-Patio", "rtspUrl": "rtsp://..." }
      ]
    },
    "b": {
      "id": "...",
      "name": "POC Tenant Bravo",
      "cameras": [
        { "id": "...", "name": "Bravo-Pasillo", "rtspUrl": "rtsp://..." }
      ]
    }
  },
  "created_at": "2026-06-10T..."
}
```

## Architecture Notes

### How token scoping works
- Stream tokens are HMAC-SHA256 signed JWT-like payloads: `base64(payload).base64url(signature)`
- Payload contains: `{ sub, tid (tenantId), cid (cameraId), sid, exp, iat, v }`
- Stream gateway verifies: signature → expiry → then checks `tid` + `cid` match the requested path
- Cross-tenant request fails because `tid` in token differs from `tenantId` in URL path

```typescript
// streamKey = `${tenantId}:${cameraId}`
// Token's tid must match the tenantId in the playback URL
function streamKey(tenantId: string, cameraId: string) {
  return `${tenantId}:${cameraId}`;
}
```

### Provision flow
1. API `POST /cameras/:id/stream-token` →
2. Calls stream-gateway `POST /provision` with `{ tenantId, cameraId, rtspUrl }` →
3. Stream gateway creates internal `StreamEntry` keyed by `${tenantId}:${cameraId}` →
4. Returns playback URL with token

### Why mock media engine locally
The local stack uses `STREAM_MEDIA_ENGINE=mock` (via `docker-compose.local.yml`). This means:
- Provision calls register the stream in-memory
- Health probes return simulated metrics (latency, packet loss)
- No actual RTSP connection is established
- **But token scoping and isolation logic is fully active**

For production: `STREAM_MEDIA_ENGINE=process` which spawns actual ffmpeg processes.

## Next: Milestone 2 (Detection)

After Milestone 1 passes:
1. Build `apps/change-detector` (OpenCV MOG2 motion gate)
2. Extend `inference-bridge` with HF YOLO proxy route
3. Wire detection → event-gateway per tenant

See `NearHome - HF Detection Integration Plan.md` for detailed phases.
