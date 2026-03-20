# Audio Detectors Compatibility Report

## Current state (as implemented today)

- Detection contract across services is mostly image-centric:
  - `DetectionObservation` assumes `bbox` persistence.
  - Job completion flow (`/internal/detections/jobs/:id/complete`) historically assumes spatial detections.
  - Tracking path creates `Track` + `TrackPoint` per detection.
- Existing reusable pieces:
  - Multi-tenant job/event/notifier plumbing is already generic by `tenantId/cameraId`.
  - Incident and notification flow is label/severity-driven and can be reused for audio labels.
  - Event publication (`detection.job`, `incident`, notification channels) is media-agnostic.
- Plugin architecture existed conceptually in node runtime, but shared TypeScript contracts were missing media-agnostic sample/event abstractions.

## Reuse / generalization split

### Reuse as-is

- Detection job lifecycle (`queued -> running -> succeeded/failed`)
- Realtime event publishing and event-gateway contracts
- Notification delivery contracts (realtime/webhook/email)
- Camera/tenant RBAC and scoping

### Must be generalized (minimal)

- Add media abstraction (`mediaKind: image | audio`) in detector event contracts.
- Add generic sample contracts for image and audio windows.
- Extend camera detection profile with optional audio config block.
- Make completion flow accept audio detections without requiring bbox/tracking semantics.

### Remain image-only (for now)

- Spatial zone resolution (`zoneMap` + bbox center lookup)
- Face artifacts pipeline and face clustering
- Track point geometry (`x/y`) semantics

## Minimal refactor implemented

1. Shared contracts (`packages/shared`):
   - Added `MediaKindSchema`, `BaseSampleSchema`, `ImageFrameSampleSchema`, `AudioWindowSampleSchema`.
   - Added generic `DetectionEventSchema` (bbox optional).
   - Added `DetectorPlugin<TSample>` and `TemporalEventAggregator` interfaces.
   - Added `CameraAudioConfigSchema` with MVP config fields and transcription mode.
   - Extended runtime/task enums to include audio capabilities.
2. Audio pipeline skeleton (`apps/audio-detection-runner/src/audio/*`):
   - source adapters: `FfmpegRtspAudioSourceAdapter` (real RTSP/go2rtc probe) + fallback stub.
   - `FixedWindowAudioSampler` (window contract stub).
   - `RmsGate` (cheap loudness gate).
   - `AudioTemporalAggregator` (merge adjacent windows by label/gap).
   - `VadAdapter` + `MockVadAdapter` + `VadDetectorPlugin`.
   - `MockAudioClassifierPlugin` with labels (`speech`, `yell`, `glass_shatter`, `loud_noise` behavior via mock heuristics).
   - `AudioDetectionPipeline` orchestration with optional transcription hook (off by default unless enabled and confidence gated).
3. API integration/orchestration (`apps/api/src/app.ts` + `apps/detection-worker/worker.py`):
   - Callback contract accepts `mediaKind`, temporal window timestamps.
   - `completeDetectionJob` now supports audio detections:
     - skips spatial tracker path for audio,
     - still persists observations/incidents/evidence,
     - writes media metadata into payload/attributes,
     - reuses existing notifier/event flow.
   - `detection-worker` routes audio jobs to `audio-detection-runner` (`/v1/infer/audio`) while keeping image jobs on `inference-bridge` (`/v1/infer`).
   - feature flag por cámara/tenant en `detectionProfile.audio.execution` (`core|detection_plane`) para rollout/rollback controlado.

## Migration strategy

- Backward compatible additive rollout:
  1. Deploy shared/API changes first (image behavior unchanged).
  2. Enable audio profile per camera via `detectionProfile.audio.enabled`.
  3. Start with mock plugin path and low-risk rules (`loud_noise` alerts).
  4. Introduce real VAD/classifier adapters behind plugin interfaces.
  5. Enable transcription only with `on_demand` or `rules_based` mode.

## Migration risk and effort

- Risk: low-to-medium.
- Effort: low for contracts/skeleton, medium for production-grade DSP/VAD model integration.
- Main technical debt retained intentionally:
  - persistence still stores `bbox` in observations; audio writes neutral bbox while carrying true temporal semantics in attributes.
  - no DB schema migration in this increment.

## Open questions

1. Should audio detections get a dedicated DB table in next increment to avoid placeholder bbox?
2. Which provider/runtime IDs will be canonical for production audio models?
3. Should `rulesProfile` include first-class cross-modal predicates (`speech + person_detected_at_night`) in API-level validation now or next phase?
4. What retention policy should apply to optional transcription payloads per tenant/privacy tier?

## Recommended next steps

1. Add first real VAD adapter (WebRTC VAD or equivalent) behind `VadAdapter`.
2. Add a real audio classifier plugin and calibrate thresholds per environment.
3. Introduce a dedicated audio observation persistence model (optional migration).
4. Add rule DSL support for explicit cross-modal conditions and time-window joins.
5. Add telemetry for gate drop-rate and per-plugin latency to tune cost/performance.
