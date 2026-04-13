import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./prisma.js";
import type {
  Role,
  RequestContext,
  CameraLifecycleStatus,
  CameraDetectionProfile,
  CameraRecordingPolicy,
  CameraNotificationRule,
  DetectorFlags,
  DetectionJobEffectiveConfig,
  DetectionQuality,
  DesiredNodeCapability,
  BridgeNodeCapability,
  BridgeNodeSnapshot,
  StreamSessionStatus,
  TenantVpnStatus,
  ProfileStatus,
} from "./types.js";
import {
  ApiDomainError,
  CameraDetectionProfileInputSchema,
  CameraConnectivitySchema,
  DetectionJobEffectiveConfigSchema,
  DesiredNodeCapabilitySchema,
  StreamGatewayHealthSchema,
} from "./types.js";

// ─── Status / code helpers ───────────────────────────────────────────────────

export function statusToCode(statusCode: number): string {
  if (statusCode === 400) return "BAD_REQUEST";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 422) return "UNPROCESSABLE_ENTITY";
  if (statusCode === 429) return "TOO_MANY_REQUESTS";
  return "INTERNAL_SERVER_ERROR";
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function toISO(date: Date) {
  return date.toISOString();
}

export function parseListQuery(query: Record<string, unknown>) {
  const start = Number(query._start ?? 0);
  const end = Number(query._end ?? start + 10);
  const sort = String(query._sort ?? "createdAt");
  const order = String(query._order ?? "DESC").toLowerCase() === "asc" ? "asc" : "desc";
  return { skip: start, take: Math.max(end - start, 1), sort, order };
}

// ─── Normalization helpers ────────────────────────────────────────────────────

export function normalizeRoleInput(role: string): Role {
  if (role === "operator") return "monitor";
  if (role === "customer") return "client_user";
  return role as Role;
}

export function normalizeObservedCapability(raw: Record<string, unknown>, index: number) {
  return {
    capabilityId: typeof raw.capabilityId === "string" ? raw.capabilityId : `cap-${index}`,
    taskTypes: Array.isArray(raw.taskTypes) ? raw.taskTypes.map(String) : [],
    qualities: Array.isArray(raw.qualities) ? raw.qualities.map(String) : [],
    models: Array.isArray(raw.models)
      ? raw.models.map(String)
      : Array.isArray(raw.modelRefs)
        ? raw.modelRefs.map(String)
        : []
  };
}

export function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

export function signStreamToken(payload: Record<string, unknown>, secret: string) {
  const serializedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(serializedPayload).digest("base64url");
  return `${serializedPayload}.${signature}`;
}

// ─── CIDR helpers ─────────────────────────────────────────────────────────────

export type ParsedIpv4Cidr = {
  cidr: string;
  network: number;
  broadcast: number;
  prefix: number;
};

export function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return null;
  return (((nums[0]! << 24) >>> 0) + ((nums[1]! << 16) >>> 0) + ((nums[2]! << 8) >>> 0) + (nums[3] >>> 0)) >>> 0;
}

export function parseIpv4Cidr(raw: string): ParsedIpv4Cidr | null {
  const value = raw.trim();
  const [ip, prefixRaw] = value.split("/");
  if (!ip || !prefixRaw) return null;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 8 || prefix > 32) return null;
  const ipInt = parseIpv4ToInt(ip);
  if (ipInt === null) return null;
  const hostBits = 32 - prefix;
  const mask = hostBits === 32 ? 0 : (0xffffffff << hostBits) >>> 0;
  const network = ipInt & mask;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { cidr: `${ip}/${prefix}`, network: network >>> 0, broadcast, prefix };
}

export function cidrOverlaps(a: ParsedIpv4Cidr, b: ParsedIpv4Cidr) {
  return a.network <= b.broadcast && b.network <= a.broadcast;
}

export const RESERVED_IPV4_CIDRS = ["127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4"]
  .map((cidr) => parseIpv4Cidr(cidr))
  .filter((entry): entry is ParsedIpv4Cidr => Boolean(entry));

export function overlapsReservedIpv4(cidr: ParsedIpv4Cidr) {
  return RESERVED_IPV4_CIDRS.some((reserved) => cidrOverlaps(cidr, reserved));
}

// ─── Lifecycle FSMs ────────────────────────────────────────────────────────────

export function canTransitionCameraLifecycle(from: CameraLifecycleStatus, to: CameraLifecycleStatus) {
  const allowed: Record<CameraLifecycleStatus, CameraLifecycleStatus[]> = {
    draft: ["provisioning", "ready", "retired", "error"],
    provisioning: ["ready", "error", "retired"],
    ready: ["degraded", "offline", "error", "retired"],
    degraded: ["ready", "offline", "error", "retired"],
    offline: ["ready", "degraded", "error", "retired"],
    error: ["draft", "provisioning", "ready", "retired"],
    retired: ["draft"]
  };
  return allowed[from].includes(to);
}

export function canTransitionTenantVpnStatus(from: TenantVpnStatus, to: TenantVpnStatus) {
  const allowed: Record<TenantVpnStatus, TenantVpnStatus[]> = {
    draft: ["validating"],
    validating: ["provisioning", "failed"],
    provisioning: ["active", "degraded", "failed"],
    active: ["degraded", "revoking"],
    degraded: ["active", "failed", "revoking"],
    failed: ["validating", "revoking"],
    revoking: ["revoked", "failed"],
    revoked: []
  };
  return allowed[from].includes(to);
}

export function canTransitionStreamSession(from: StreamSessionStatus, to: StreamSessionStatus) {
  const allowed: Record<StreamSessionStatus, StreamSessionStatus[]> = {
    requested: ["issued", "ended", "expired"],
    issued: ["active", "ended", "expired"],
    active: ["ended", "expired"],
    ended: [],
    expired: []
  };
  return allowed[from].includes(to);
}

export function lifecycleFromConnectivity(connectivity: "online" | "degraded" | "offline"): CameraLifecycleStatus {
  if (connectivity === "online") return "ready";
  if (connectivity === "degraded") return "degraded";
  return "offline";
}

export function isAudioTaskType(taskType: string) {
  return taskType === "speech_detection" || taskType === "audio_event_classification" || taskType === "transcription";
}

// ─── Camera profile helpers ───────────────────────────────────────────────────

export function isProfileConfigComplete(profile: {
  proxyPath: string;
  recordingStorageKey: string;
  detectorConfigKey: string;
  detectorResultsKey: string;
}) {
  return (
    profile.proxyPath.trim().length > 0 &&
    profile.recordingStorageKey.trim().length > 0 &&
    profile.detectorConfigKey.trim().length > 0 &&
    profile.detectorResultsKey.trim().length > 0
  );
}

export function defaultCameraDetectionProfile(tenantId: string, cameraId: string): CameraDetectionProfile {
  return {
    cameraId,
    tenantId,
    pipelines: [],
    audio: {
      enabled: false,
      execution: "detection_plane",
      sampleRate: 16000,
      channels: 1,
      windowMs: 500,
      overlapMs: 250,
      minVolume: 0.02,
      detectors: [],
      transcription: { enabled: false, mode: "off", minConfidence: 0.75 }
    },
    configVersion: 1,
    updatedAt: new Date().toISOString()
  };
}

export function defaultCameraProfileData(tenantId: string, cameraId: string) {
  return {
    tenantId,
    cameraId,
    proxyPath: `/proxy/live/${tenantId}/${cameraId}`,
    recordingEnabled: false,
    recordingStorageKey: `s3://nearhome/${tenantId}/recordings/${cameraId}`,
    detectorConfigKey: `kv://nearhome/${tenantId}/detectors/${cameraId}/config.json`,
    detectorResultsKey: `s3://nearhome/${tenantId}/detectors/${cameraId}/results`,
    detectorFlags: JSON.stringify({ mediapipe: true, yolo: false, lpr: false } satisfies DetectorFlags),
    zoneMap: null as string | null,
    homography: null as string | null,
    sceneTags: JSON.stringify([] as string[]),
    rulesProfile: JSON.stringify({} as Record<string, unknown>),
    detectionProfile: JSON.stringify(defaultCameraDetectionProfile(tenantId, cameraId)),
    status: "ready" as ProfileStatus,
    lastHealthAt: new Date(),
    lastError: null as string | null
  };
}

export function parseCameraDetectionProfile(raw: string | null, tenantId: string, cameraId: string): CameraDetectionProfile {
  const fallback = defaultCameraDetectionProfile(tenantId, cameraId);
  if (!raw) return fallback;
  try {
    const source = parseJson<Record<string, unknown>>(raw);
    const parsed = CameraDetectionProfileInputSchema.partial().parse(source);
    return {
      cameraId,
      tenantId,
      pipelines: parsed.pipelines ?? fallback.pipelines,
      audio: parsed.audio ?? fallback.audio,
      configVersion: parsed.configVersion ?? fallback.configVersion,
      updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : fallback.updatedAt
    };
  } catch {
    return fallback;
  }
}

export function serializeCameraDetectionProfile(profile: CameraDetectionProfile): string {
  return JSON.stringify({
    cameraId: profile.cameraId,
    tenantId: profile.tenantId,
    pipelines: profile.pipelines,
    audio: profile.audio,
    configVersion: profile.configVersion,
    updatedAt: profile.updatedAt
  });
}

export function parseCameraRecordingPolicy(rulesProfileRaw: string | null): CameraRecordingPolicy {
  const fallback: CameraRecordingPolicy = { mode: "continuous", eventClipPreSeconds: 5, eventClipPostSeconds: 10 };
  if (!rulesProfileRaw) return fallback;
  try {
    const parsed = parseJson<Record<string, unknown>>(rulesProfileRaw);
    const recording = parsed.recording;
    if (!recording || typeof recording !== "object") return fallback;
    const value = recording as Record<string, unknown>;
    const mode = value.mode;
    const preSeconds = typeof value.eventClipPreSeconds === "number" ? Math.floor(value.eventClipPreSeconds) : fallback.eventClipPreSeconds;
    const postSeconds = typeof value.eventClipPostSeconds === "number" ? Math.floor(value.eventClipPostSeconds) : fallback.eventClipPostSeconds;
    return {
      mode: mode === "event_only" || mode === "hybrid" || mode === "continuous" || mode === "observe_only" ? mode : fallback.mode,
      eventClipPreSeconds: Math.max(0, Math.min(120, preSeconds)),
      eventClipPostSeconds: Math.max(1, Math.min(300, postSeconds))
    };
  } catch {
    return fallback;
  }
}

export function parseCameraNotificationRule(rulesProfileRaw: string | null): CameraNotificationRule {
  const fallback: CameraNotificationRule = {
    enabled: false,
    minConfidence: 0.6,
    labels: [],
    cooldownSeconds: 30,
    channels: { realtime: true, webhook: false, email: false }
  };
  if (!rulesProfileRaw) return fallback;
  try {
    const parsed = parseJson<Record<string, unknown>>(rulesProfileRaw);
    const notification = parsed.notification;
    if (!notification || typeof notification !== "object") return fallback;
    const value = notification as Record<string, unknown>;
    const channelsRaw = value.channels && typeof value.channels === "object" ? (value.channels as Record<string, unknown>) : {};
    const labels = Array.isArray(value.labels) ? value.labels.filter((e): e is string => typeof e === "string" && e.trim().length > 0) : [];
    const minConfidenceRaw = typeof value.minConfidence === "number" ? value.minConfidence : fallback.minConfidence;
    const cooldownRaw = typeof value.cooldownSeconds === "number" ? Math.floor(value.cooldownSeconds) : fallback.cooldownSeconds;
    return {
      enabled: value.enabled === true,
      minConfidence: Math.max(0, Math.min(1, minConfidenceRaw)),
      labels,
      cooldownSeconds: Math.max(0, Math.min(3600, cooldownRaw)),
      channels: { realtime: channelsRaw.realtime !== false, webhook: channelsRaw.webhook === true, email: channelsRaw.email === true }
    };
  } catch {
    return fallback;
  }
}

// ─── Response serializers ─────────────────────────────────────────────────────

export function profileResponse(profile: {
  id: string; tenantId: string; cameraId: string; proxyPath: string; recordingEnabled: boolean;
  recordingStorageKey: string; detectorConfigKey: string; detectorResultsKey: string; detectorFlags: string;
  zoneMap: string | null; homography: string | null; sceneTags: string | null; rulesProfile: string | null;
  detectionProfile: string | null; status: string; lastHealthAt: Date | null; lastError: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: profile.id,
    tenantId: profile.tenantId,
    cameraId: profile.cameraId,
    proxyPath: profile.proxyPath,
    recordingEnabled: profile.recordingEnabled,
    recordingStorageKey: profile.recordingStorageKey,
    detectorConfigKey: profile.detectorConfigKey,
    detectorResultsKey: profile.detectorResultsKey,
    detectorFlags: parseJson<DetectorFlags>(profile.detectorFlags),
    zoneMap: profile.zoneMap ? parseJson<Record<string, unknown>>(profile.zoneMap) : undefined,
    homography: profile.homography ? parseJson<Record<string, unknown>>(profile.homography) : undefined,
    sceneTags: profile.sceneTags ? parseJson<string[]>(profile.sceneTags) : undefined,
    rulesProfile: profile.rulesProfile ? parseJson<Record<string, unknown>>(profile.rulesProfile) : undefined,
    detectionProfile: parseCameraDetectionProfile(profile.detectionProfile, profile.tenantId, profile.cameraId),
    status: profile.status as ProfileStatus,
    configComplete: isProfileConfigComplete(profile),
    lastHealthAt: profile.lastHealthAt ? toISO(profile.lastHealthAt) : null,
    lastError: profile.lastError,
    createdAt: toISO(profile.createdAt),
    updatedAt: toISO(profile.updatedAt)
  };
}

export function cameraResponse(camera: {
  id: string; tenantId: string; name: string; description: string | null; rtspUrl: string;
  location: string | null; tags: string; isActive: boolean; lifecycleStatus: string;
  lastSeenAt: Date | null; lastTransitionAt: Date | null; createdAt: Date;
  profile?: Parameters<typeof profileResponse>[0] | null;
}) {
  return {
    id: camera.id,
    tenantId: camera.tenantId,
    name: camera.name,
    description: camera.description,
    rtspUrl: camera.rtspUrl,
    location: camera.location,
    tags: parseJson<string[]>(camera.tags),
    isActive: camera.isActive,
    lifecycleStatus: camera.lifecycleStatus as CameraLifecycleStatus,
    lastSeenAt: camera.lastSeenAt ? toISO(camera.lastSeenAt) : null,
    lastTransitionAt: camera.lastTransitionAt ? toISO(camera.lastTransitionAt) : null,
    createdAt: toISO(camera.createdAt),
    ...(camera.profile ? { profile: profileResponse(camera.profile) } : {})
  };
}

export function streamSessionResponse(session: {
  id: string; tenantId: string; cameraId: string; userId: string; status: string;
  token: string; expiresAt: Date; issuedAt: Date; activatedAt: Date | null;
  endedAt: Date | null; endReason: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: session.id,
    tenantId: session.tenantId,
    cameraId: session.cameraId,
    userId: session.userId,
    status: session.status as StreamSessionStatus,
    token: session.token,
    expiresAt: toISO(session.expiresAt),
    issuedAt: toISO(session.issuedAt),
    activatedAt: session.activatedAt ? toISO(session.activatedAt) : null,
    endedAt: session.endedAt ? toISO(session.endedAt) : null,
    endReason: session.endReason,
    createdAt: toISO(session.createdAt),
    updatedAt: toISO(session.updatedAt)
  };
}

export function auditLogResponse(entry: {
  id: string; tenantId: string; actorUserId: string | null; resource: string; action: string;
  resourceId: string | null; payload: string | null; createdAt: Date;
}) {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    resource: entry.resource,
    action: entry.action,
    resourceId: entry.resourceId,
    payload: entry.payload ? parseJson<Record<string, unknown>>(entry.payload) : null,
    createdAt: toISO(entry.createdAt)
  };
}

export function householdResponse(row: {
  id: string; tenantId: string; name: string; address: string | null; notes: string | null;
  isActive: boolean; createdByUserId: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: row.id, tenantId: row.tenantId, name: row.name, address: row.address, notes: row.notes,
    isActive: row.isActive, createdByUserId: row.createdByUserId,
    createdAt: toISO(row.createdAt), updatedAt: toISO(row.updatedAt)
  };
}

export function serializeNetworkSpace(space: {
  id: string; spaceType: string; cidr: string; gatewayIp: string | null;
  dnsServers: string | null; isPrimary: boolean; status: string;
}) {
  return {
    id: space.id,
    spaceType: space.spaceType,
    cidr: space.cidr,
    gatewayIp: space.gatewayIp,
    dnsServers: parseJson<string[]>(space.dnsServers ?? "[]"),
    isPrimary: space.isPrimary,
    status: space.status
  };
}

// ─── Request context helpers ──────────────────────────────────────────────────

export function assertRole(request: FastifyRequest, roles: Role[]) {
  if (request.ctx?.isSuperuser && !request.ctx?.isImpersonating) return;
  if (!request.ctx?.role || !roles.includes(request.ctx.role)) {
    throw new Error("FORBIDDEN_ROLE");
  }
}

export function hasGlobalSuperuserPrivileges(request: FastifyRequest) {
  return Boolean(request.ctx?.isSuperuser && !request.ctx?.isImpersonating);
}

export function getTenantContext(request: FastifyRequest): { userId: string; tenantId: string; role?: Role } {
  if (!request.ctx?.tenantId) throw new Error("MISSING_TENANT");
  return { userId: request.ctx.userId, tenantId: request.ctx.tenantId, role: request.ctx.role };
}

// ─── Domain functions (use prisma) ────────────────────────────────────────────

export async function getCameraScopeForUser(args: { tenantId: string; userId: string; role?: Role }) {
  if (!args.role || !["monitor", "client_user"].includes(args.role)) return null;
  const assignments = await prisma.cameraAssignment.findMany({
    where: { tenantId: args.tenantId, userId: args.userId },
    select: { cameraId: true }
  });
  if (!assignments.length) return null;
  return assignments.map((a) => a.cameraId);
}

export async function assertCameraAccess(args: { tenantId: string; userId: string; role?: Role; cameraId: string }) {
  const scopedCameraIds = await getCameraScopeForUser(args);
  if (!scopedCameraIds) return;
  if (!scopedCameraIds.includes(args.cameraId)) throw new Error("CAMERA_NOT_FOUND");
}

export async function appendAuditLog(args: {
  tenantId: string;
  actorUserId?: string;
  resource: string;
  action: string;
  resourceId?: string;
  payload?: Record<string, unknown>;
  context?: RequestContext;
}) {
  const actorUserId = args.actorUserId ?? args.context?.realUserId ?? args.context?.userId;
  const authContext = args.context
    ? {
        actorUserId: args.context.realUserId ?? args.context.userId,
        effectiveUserId: args.context.userId,
        effectiveRole: args.context.role ?? null,
        isSuperuser: Boolean(args.context.isSuperuser),
        isImpersonating: Boolean(args.context.isImpersonating),
        impersonatedRole: args.context.impersonatedRole ?? null,
        tenantId: args.context.tenantId ?? null
      }
    : undefined;
  const payload =
    args.payload || authContext
      ? { ...(args.payload ?? {}), ...(authContext ? { _auth: authContext } : {}) }
      : undefined;
  await prisma.auditLog.create({
    data: {
      tenantId: args.tenantId,
      actorUserId: actorUserId ?? null,
      resource: args.resource,
      action: args.action,
      resourceId: args.resourceId ?? null,
      payload: payload ? JSON.stringify(payload) : null
    }
  });
}

export async function appendLifecycleLog(args: {
  tenantId: string; cameraId: string; fromStatus: CameraLifecycleStatus | null;
  toStatus: CameraLifecycleStatus; event: string; reason?: string | null; actorUserId?: string;
}) {
  await prisma.cameraLifecycleLog.create({
    data: {
      tenantId: args.tenantId,
      cameraId: args.cameraId,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      event: args.event,
      reason: args.reason ?? null,
      actorUserId: args.actorUserId
    }
  });
}

export async function transitionCameraLifecycle(args: {
  tenantId: string; cameraId: string; toStatus: CameraLifecycleStatus;
  event: string; reason?: string | null; actorUserId?: string;
}) {
  const camera = await prisma.camera.findFirst({ where: { id: args.cameraId, tenantId: args.tenantId, deletedAt: null } });
  if (!camera) throw new Error("CAMERA_NOT_FOUND");
  const fromStatus = camera.lifecycleStatus as CameraLifecycleStatus;
  if (fromStatus !== args.toStatus && !canTransitionCameraLifecycle(fromStatus, args.toStatus)) {
    throw new Error("INVALID_LIFECYCLE_TRANSITION");
  }
  const updated = await prisma.camera.update({
    where: { id: camera.id },
    data: {
      lifecycleStatus: args.toStatus,
      lastTransitionAt: new Date(),
      ...(args.toStatus === "ready" ? { lastSeenAt: new Date() } : {})
    },
    include: { profile: true }
  });
  await appendLifecycleLog({ tenantId: args.tenantId, cameraId: args.cameraId, fromStatus, toStatus: args.toStatus, event: args.event, reason: args.reason, actorUserId: args.actorUserId });
  return updated;
}

export async function appendStreamSessionTransition(args: {
  streamSessionId: string; tenantId: string; fromStatus: StreamSessionStatus | null;
  toStatus: StreamSessionStatus; event: string; actorUserId?: string;
}) {
  await prisma.streamSessionTransition.create({
    data: {
      streamSessionId: args.streamSessionId,
      tenantId: args.tenantId,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      event: args.event,
      actorUserId: args.actorUserId
    }
  });
}

export async function transitionStreamSession(args: {
  tenantId: string; streamSessionId: string; toStatus: StreamSessionStatus;
  event: string; actorUserId?: string; endReason?: string | null;
}) {
  const session = await prisma.streamSession.findFirst({ where: { id: args.streamSessionId, tenantId: args.tenantId } });
  if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");
  const fromStatus = session.status as StreamSessionStatus;
  if (fromStatus !== args.toStatus && !canTransitionStreamSession(fromStatus, args.toStatus)) {
    throw new Error("INVALID_STREAM_SESSION_TRANSITION");
  }
  const now = new Date();
  const updated = await prisma.streamSession.update({
    where: { id: session.id },
    data: {
      status: args.toStatus,
      ...(args.toStatus === "active" ? { activatedAt: now } : {}),
      ...(args.toStatus === "ended" || args.toStatus === "expired" ? { endedAt: now } : {}),
      ...(args.toStatus === "ended" ? { endReason: args.endReason ?? "ended by user action" } : {})
    }
  });
  await appendStreamSessionTransition({
    streamSessionId: session.id, tenantId: args.tenantId, fromStatus, toStatus: args.toStatus,
    event: args.event, actorUserId: args.actorUserId
  });
  return updated;
}

export async function expireStaleStreamSessions(tenantId: string) {
  const stale = await prisma.streamSession.findMany({
    where: { tenantId, status: { in: ["requested", "issued", "active"] }, expiresAt: { lt: new Date() } }
  });
  for (const session of stale) {
    await transitionStreamSession({ tenantId, streamSessionId: session.id, toStatus: "expired", event: "stream.expired" });
  }
}

export async function transitionTenantVpnLifecycle(args: {
  tenantId: string; vpnId: string; toStatus: TenantVpnStatus;
  reason?: string | null; actorUserId?: string; context?: RequestContext; event: string;
}) {
  const vpn = await prisma.tenantVpn.findFirst({ where: { id: args.vpnId, tenantId: args.tenantId } });
  if (!vpn) throw new ApiDomainError({ statusCode: 404, apiCode: "NOT_FOUND", message: "VPN not found" });
  const fromStatus = vpn.status as TenantVpnStatus;
  if (fromStatus !== args.toStatus && !canTransitionTenantVpnStatus(fromStatus, args.toStatus)) {
    throw new ApiDomainError({
      statusCode: 422,
      apiCode: "INVALID_VPN_TRANSITION",
      message: `Cannot transition VPN from ${fromStatus} to ${args.toStatus}`
    });
  }
  const updated = await prisma.tenantVpn.update({
    where: { id: vpn.id },
    data: { status: args.toStatus, updatedAt: new Date() }
  });
  await appendAuditLog({
    tenantId: args.tenantId,
    actorUserId: args.actorUserId,
    context: args.context,
    resource: "tenant_vpn",
    action: "lifecycle_transition",
    resourceId: vpn.id,
    payload: { event: args.event, fromStatus, toStatus: args.toStatus, reason: args.reason ?? null }
  });
  return updated;
}

export async function syncCameraHealthFromGateway(args: {
  tenantId: string; cameraId: string; actorUserId?: string; streamGatewayUrl: string;
}) {
  const camera = await prisma.camera.findFirst({ where: { id: args.cameraId, tenantId: args.tenantId, deletedAt: null } });
  if (!camera) throw new Error("CAMERA_NOT_FOUND");

  const response = await fetch(`${args.streamGatewayUrl}/health/${args.tenantId}/${args.cameraId}`);
  let connectivity: "online" | "degraded" | "offline" = "offline";
  let latencyMs: number | null = null;
  let packetLossPct: number | null = null;
  let jitterMs: number | null = null;
  let healthError: string | null = null;

  if (response.ok) {
    const payload = StreamGatewayHealthSchema.parse(await response.json());
    connectivity = payload.data.status === "provisioning" ? "degraded" : payload.data.health.connectivity;
    latencyMs = payload.data.health.latencyMs;
    packetLossPct = payload.data.health.packetLossPct;
    jitterMs = payload.data.health.jitterMs;
    healthError = payload.data.health.error;
  } else {
    connectivity = "offline";
    healthError = response.status === 404 ? "not_provisioned" : "stream_gateway_unreachable";
  }

  await prisma.cameraHealthSnapshot.upsert({
    where: { cameraId: args.cameraId },
    update: { connectivity, latencyMs, packetLossPct, jitterMs, error: healthError, checkedAt: new Date() },
    create: { tenantId: args.tenantId, cameraId: args.cameraId, connectivity, latencyMs, packetLossPct, jitterMs, error: healthError, checkedAt: new Date() }
  });

  let nextLifecycle = lifecycleFromConnectivity(connectivity);
  const currentLifecycle = camera.lifecycleStatus as CameraLifecycleStatus;
  if (currentLifecycle === "retired") nextLifecycle = "retired";
  else if (currentLifecycle === "draft" && nextLifecycle !== "ready") nextLifecycle = "error";
  else if (!canTransitionCameraLifecycle(currentLifecycle, nextLifecycle)) nextLifecycle = currentLifecycle;

  const transitioned = await transitionCameraLifecycle({
    tenantId: args.tenantId, cameraId: args.cameraId, toStatus: nextLifecycle,
    event: "camera.health_synced", reason: `source=stream-gateway connectivity=${connectivity}`,
    actorUserId: args.actorUserId
  });
  await appendAuditLog({
    tenantId: args.tenantId, actorUserId: args.actorUserId, resource: "camera", action: "health_sync",
    resourceId: args.cameraId, payload: { connectivity, lifecycleStatus: transitioned.lifecycleStatus }
  });
  return { data: cameraResponse(transitioned), sync: { source: "stream-gateway" as const, connectivity, error: healthError } };
}

// ─── Inference node helpers ───────────────────────────────────────────────────

export function normalizeBridgeNode(nodeRaw: Record<string, unknown>): BridgeNodeSnapshot | null {
  const nodeId = typeof nodeRaw.nodeId === "string" ? nodeRaw.nodeId : null;
  if (!nodeId) return null;
  const tenantId = typeof nodeRaw.tenantId === "string" && nodeRaw.tenantId.length > 0 ? nodeRaw.tenantId : null;
  const tenantIds = Array.isArray(nodeRaw.tenantIds)
    ? nodeRaw.tenantIds.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  const runtime = typeof nodeRaw.runtime === "string" ? nodeRaw.runtime : "unknown";
  const transport = typeof nodeRaw.transport === "string" ? nodeRaw.transport : "http";
  const endpoint = typeof nodeRaw.endpoint === "string" ? nodeRaw.endpoint : "";
  const statusValue = typeof nodeRaw.status === "string" ? nodeRaw.status : "offline";
  const status: "online" | "degraded" | "offline" = statusValue === "online" || statusValue === "degraded" ? statusValue : "offline";
  const resourcesRaw = nodeRaw.resources && typeof nodeRaw.resources === "object" ? (nodeRaw.resources as Record<string, unknown>) : { cpu: 0, gpu: 0, vramMb: 0 };
  const resources = Object.fromEntries(Object.entries(resourcesRaw).map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : 0]));
  const capabilitiesRaw = Array.isArray(nodeRaw.capabilities) ? nodeRaw.capabilities : [];
  const capabilities: BridgeNodeCapability[] = capabilitiesRaw.map((item, index) => {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      capabilityId: typeof entry.capabilityId === "string" && entry.capabilityId.length > 0 ? entry.capabilityId : `cap-${index}`,
      taskTypes: Array.isArray(entry.taskTypes) ? entry.taskTypes.filter((x): x is string => typeof x === "string") : [],
      models: Array.isArray(entry.models) ? entry.models.filter((x): x is string => typeof x === "string") : []
    };
  });
  const models = Array.isArray(nodeRaw.models) ? nodeRaw.models.filter((x): x is string => typeof x === "string") : [];
  const maxConcurrent = Number.isFinite(Number(nodeRaw.maxConcurrent)) ? Math.max(1, Number(nodeRaw.maxConcurrent)) : 1;
  const queueDepth = Number.isFinite(Number(nodeRaw.queueDepth)) ? Math.max(0, Number(nodeRaw.queueDepth)) : 0;
  const isDrained = nodeRaw.isDrained === true;
  const parsedHeartbeat = typeof nodeRaw.lastHeartbeatAt === "string" ? Date.parse(nodeRaw.lastHeartbeatAt) : Date.now();
  const lastHeartbeatAt = Number.isFinite(parsedHeartbeat) ? new Date(parsedHeartbeat) : new Date();
  const contractVersion = typeof nodeRaw.contractVersion === "string" ? nodeRaw.contractVersion : "1.0";
  return { nodeId, tenantId, tenantIds, runtime, transport, endpoint, status, resources, capabilities, models, maxConcurrent, queueDepth, isDrained, lastHeartbeatAt, contractVersion };
}

export function extractDetectionJobEffectiveConfig(options: Record<string, unknown> | null | undefined): DetectionJobEffectiveConfig | undefined {
  if (!options) return undefined;
  const parsed = DetectionJobEffectiveConfigSchema.safeParse(options.resolvedConfig);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeDesiredNodeCapabilities(capabilities: Array<Record<string, unknown> | DesiredNodeCapability>): DesiredNodeCapability[] {
  return capabilities.map((entry, index) => {
    const raw = entry && typeof entry === "object" ? entry : {};
    const parsed = DesiredNodeCapabilitySchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return {
      capabilityId: typeof (raw as Record<string, unknown>).capabilityId === "string" ? String((raw as Record<string, unknown>).capabilityId) : `cap-${index}`,
      taskTypes: [],
      qualities: [],
      modelRefs: []
    };
  });
}

export function normalizeDesiredNodeConfig(args: {
  nodeId: string; runtime: string; transport: string; endpoint: string;
  desiredResources: string; desiredModels: string; desiredCapabilities: string;
  desiredTenantIds: string; maxConcurrent: number; contractVersion: string;
  configVersion: number; lastAppliedAt: Date | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    nodeId: args.nodeId,
    runtime: args.runtime,
    transport: args.transport,
    endpoint: args.endpoint,
    resources: parseJson<Record<string, number>>(args.desiredResources),
    capabilities: normalizeDesiredNodeCapabilities(parseJson<Array<Record<string, unknown>>>(args.desiredCapabilities)),
    models: parseJson<string[]>(args.desiredModels),
    tenantIds: parseJson<string[]>(args.desiredTenantIds),
    maxConcurrent: args.maxConcurrent,
    contractVersion: args.contractVersion,
    configVersion: args.configVersion,
    lastAppliedAt: args.lastAppliedAt ? toISO(args.lastAppliedAt) : null,
    createdAt: toISO(args.createdAt),
    updatedAt: toISO(args.updatedAt)
  };
}

// ─── Deploy bundle / node helpers ────────────────────────────────────────────

export function resolveRepoRoot() {
  if (existsSync(resolve(process.cwd(), "package.json")) && existsSync(resolve(process.cwd(), "infra"))) {
    return process.cwd();
  }
  return resolve(process.cwd(), "..", "..");
}

export function resolveDefaultDetectionDeployOutputPath() {
  const cwdInfraPath = resolve(process.cwd(), "infra", "docker-compose.detection.generated.yml");
  if (existsSync(resolve(process.cwd(), "infra"))) return cwdInfraPath;
  return resolve(process.cwd(), "..", "..", "infra", "docker-compose.detection.generated.yml");
}

export function yamlScalar(value: unknown) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

export function renderYaml(value: unknown, indent = 0): string {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${prefix}[]`;
    return value.map((item) => {
      if (item && typeof item === "object") {
        const nested = renderYaml(item, indent + 2);
        const [firstLine, ...rest] = nested.split("\n");
        return `${prefix}- ${firstLine!.trimStart()}${rest.length ? `\n${rest.join("\n")}` : ""}`;
      }
      return `${prefix}- ${yamlScalar(item)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${prefix}{}`;
    return entries.map(([key, item]) => {
      if (item && typeof item === "object") return `${prefix}${key}:\n${renderYaml(item, indent + 2)}`;
      return `${prefix}${key}: ${yamlScalar(item)}`;
    }).join("\n");
  }
  return `${prefix}${yamlScalar(value)}`;
}

export function buildDeployBundle(definitions: Array<ReturnType<typeof buildNodeDeployDefinition>>) {
  const effectiveDefinitions = definitions.filter((d): d is NonNullable<typeof d> => Boolean(d));
  const services: Record<string, unknown> = {};
  for (const def of effectiveDefinitions) Object.assign(services, def.composeService);
  const composeYaml = ["services:", renderYaml(services, 2), ""].join("\n");
  return {
    generatedAt: new Date().toISOString(),
    nodeIds: effectiveDefinitions.map((d) => d.nodeId),
    warnings: effectiveDefinitions.flatMap((d) => d.warnings.map((w) => ({ nodeId: d.nodeId, message: w }))),
    composeYaml,
    definitions: effectiveDefinitions
  };
}

export async function persistDeployBundle(args: { bundle: ReturnType<typeof buildDeployBundle>; outputPath: string }) {
  const resolvedPath = resolve(args.outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, args.bundle.composeYaml, "utf8");
  return {
    path: resolvedPath,
    bytes: Buffer.byteLength(args.bundle.composeYaml, "utf8"),
    nodeCount: args.bundle.nodeIds.length,
    warningCount: args.bundle.warnings.length,
    generatedAt: args.bundle.generatedAt
  };
}

export function extractPortFromEndpoint(endpoint: string, fallbackPort: number) {
  try {
    const url = new URL(endpoint);
    if (url.port) return Number(url.port);
  } catch {}
  return fallbackPort;
}

export function buildNodeConfigDiff(args: {
  desired: ReturnType<typeof normalizeDesiredNodeConfig> | null;
  observed: {
    runtime: string; transport: string; endpoint: string; resources: Record<string, number>;
    capabilities: BridgeNodeCapability[]; models: string[]; assignedTenantIds: string[]; maxConcurrent: number;
  } | null;
}) {
  if (!args.desired || !args.observed) {
    return { inSync: false, items: [{ field: "presence", desired: Boolean(args.desired), observed: Boolean(args.observed) }] };
  }
  const items: Array<{ field: string; desired: unknown; observed: unknown }> = [];
  const compare = (field: string, desired: unknown, observed: unknown) => {
    if (JSON.stringify(desired) !== JSON.stringify(observed)) items.push({ field, desired, observed });
  };
  compare("runtime", args.desired.runtime, args.observed.runtime);
  compare("transport", args.desired.transport, args.observed.transport);
  compare("endpoint", args.desired.endpoint, args.observed.endpoint);
  compare("resources", args.desired.resources, args.observed.resources);
  compare("models", args.desired.models, args.observed.models);
  compare("capabilities", args.desired.capabilities, args.observed.capabilities);
  compare("tenantIds", args.desired.tenantIds, args.observed.assignedTenantIds);
  compare("maxConcurrent", args.desired.maxConcurrent, args.observed.maxConcurrent);
  return { inSync: items.length === 0, items };
}

export function buildNodeDeployDefinition(args: {
  nodeId: string;
  desired: ReturnType<typeof normalizeDesiredNodeConfig> | null;
  observed: { runtime: string; transport: string; endpoint: string; resources: Record<string, number>; capabilities: BridgeNodeCapability[]; models: string[]; assignedTenantIds: string[]; maxConcurrent: number; status: string; queueDepth: number; isDrained: boolean; lastHeartbeatAt: string; updatedAt: string; } | null;
}) {
  const source = args.desired ? "desired" : "observed";
  const base = args.desired ?? args.observed;
  if (!base) return null;
  const port = extractPortFromEndpoint(base.endpoint, base.runtime === "mediapipe" ? 8092 : 8091);
  const { nodeId } = args;
  const runtime = base.runtime;
  const capabilityList = Array.isArray(base.capabilities) ? (base.capabilities as any[]) : [];
  const taskTypes = Array.from(
    new Set(capabilityList.flatMap((c: any) => c.taskTypes ?? []).filter((v: unknown) => typeof v === "string"))
  ) as string[];
  const modelRefs = Array.from(
    new Set(
      [
        ...((("models" in base && Array.isArray(base.models) ? base.models : []) as string[])),
        ...capabilityList.flatMap((c: any) => c.modelRefs ?? c.models ?? [])
      ].filter((v) => typeof v === "string" && v.length > 0)
    )
  );
  const tenantIds =
    "tenantIds" in base && Array.isArray(base.tenantIds)
      ? base.tenantIds
      : "assignedTenantIds" in base && Array.isArray(base.assignedTenantIds)
        ? base.assignedTenantIds
        : [];
  const serviceName = `inference-node-${runtime}-${nodeId.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
  const buildContext = runtime === "mediapipe" ? "../apps/inference-node-mediapipe" : "../apps/inference-node-yolo";
  const env = {
    INFERENCE_BRIDGE_URL: "http://inference-bridge:8090",
    NODE_ID: nodeId,
    NODE_RUNTIME: runtime,
    NODE_TRANSPORT: base.transport,
    NODE_ENDPOINT: base.endpoint,
    NODE_TENANT_ID: tenantIds.length === 1 ? tenantIds[0] : "",
    NODE_TENANT_IDS: tenantIds.join(","),
    NODE_TASK_TYPES: taskTypes.join(","),
    NODE_MODELS: modelRefs.join(","),
    NODE_MAX_CONCURRENT: String(base.maxConcurrent),
    NODE_RESOURCES_CPU: String((base.resources as any)?.cpu ?? 0),
    NODE_RESOURCES_GPU: String((base.resources as any)?.gpu ?? 0),
    NODE_RESOURCES_VRAM_MB: String((base.resources as any)?.vramMb ?? 0),
    NODE_HEARTBEAT_INTERVAL_MS: "10000",
    NODE_CONTRACT_VERSION: "contractVersion" in base ? base.contractVersion : "1.0",
    NODE_AUTH_ADMIN_SECRET: "${NODE_AUTH_ADMIN_SECRET}"
  };
  const warnings: string[] = [];
  if (taskTypes.length === 0) warnings.push("Node does not declare any taskTypes");
  if (modelRefs.length === 0) warnings.push("Node does not declare any models");
  if (runtime === "yolo" && taskTypes.includes("face_detection") && !modelRefs.some((m) => m.includes("face"))) {
    warnings.push("Face detection is declared but no face-specific modelRef was found");
  }
  return {
    nodeId,
    source,
    runtime,
    serviceName,
    deploymentContractVersion: "1.0",
    imageHint: runtime === "mediapipe" ? "nearhome/inference-node-mediapipe:local" : "nearhome/inference-node-yolo:local",
    build: { context: buildContext, dockerfile: "Dockerfile" },
    env,
    ports: [`${port}:${port}`],
    dependsOn: ["inference-bridge"],
    networks: ["nearhome_net"],
    warnings,
    composeService: {
      [serviceName]: {
        build: { context: buildContext, dockerfile: "Dockerfile" },
        environment: env,
        ports: [`${port}:${port}`],
        depends_on: ["inference-bridge"],
        networks: ["nearhome_net"]
      }
    }
  };
}

export async function syncInferenceNodeSnapshots(nodesRaw: Array<Record<string, unknown>>) {
  const normalized = nodesRaw.map(normalizeBridgeNode).filter((item): item is BridgeNodeSnapshot => Boolean(item));
  if (!normalized.length) return;
  const tenantIds = Array.from(
    new Set(normalized.flatMap((n) => [n.tenantId, ...n.tenantIds]).filter((id): id is string => Boolean(id)))
  );
  const existingTenants = tenantIds.length
    ? await prisma.tenant.findMany({ where: { id: { in: tenantIds }, deletedAt: null }, select: { id: true } })
    : [];
  const validTenantIds = new Set(existingTenants.map((t) => t.id));

  for (const node of normalized) {
    const bridgeTenantIds = Array.from(
      new Set([node.tenantId, ...node.tenantIds].filter((id): id is string => Boolean(id && validTenantIds.has(id))))
    );
    const existing = await prisma.inferenceNodeSnapshot.findUnique({ where: { nodeId: node.nodeId }, include: { assignments: { select: { tenantId: true } } } });
    const existingTenantIds = existing ? existing.assignments.map((a) => a.tenantId) : [];
    const effectiveTenantIds = bridgeTenantIds.length > 0 ? bridgeTenantIds : existingTenantIds;
    const tenantId = effectiveTenantIds.length === 1 ? effectiveTenantIds[0]! : null;
    await prisma.inferenceNodeSnapshot.upsert({
      where: { nodeId: node.nodeId },
      update: {
        tenantId, runtime: node.runtime, transport: node.transport, endpoint: node.endpoint,
        status: node.status, resources: JSON.stringify(node.resources), capabilities: JSON.stringify(node.capabilities),
        models: JSON.stringify(node.models), maxConcurrent: node.maxConcurrent, queueDepth: node.queueDepth,
        isDrained: node.isDrained, lastHeartbeatAt: node.lastHeartbeatAt, contractVersion: node.contractVersion
      },
      create: {
        nodeId: node.nodeId, tenantId, runtime: node.runtime, transport: node.transport, endpoint: node.endpoint,
        status: node.status, resources: JSON.stringify(node.resources), capabilities: JSON.stringify(node.capabilities),
        models: JSON.stringify(node.models), maxConcurrent: node.maxConcurrent, queueDepth: node.queueDepth,
        isDrained: node.isDrained, lastHeartbeatAt: node.lastHeartbeatAt, contractVersion: node.contractVersion
      }
    });
    if (bridgeTenantIds.length > 0) {
      await prisma.inferenceNodeTenantAssignment.deleteMany({ where: { nodeId: node.nodeId } });
      await prisma.inferenceNodeTenantAssignment.createMany({
        data: bridgeTenantIds.map((tid) => ({ nodeId: node.nodeId, tenantId: tid }))
      });
    }
  }
}

// ─── Entitlements + enforcement ──────────────────────────────────────────────

const EntitlementsSchema = z.object({
  planCode: z.string(),
  limits: z.object({
    maxCameras: z.number(),
    maxConcurrentStreams: z.number(),
    retentionDays: z.number()
  }).passthrough(),
  features: z.record(z.unknown())
});

export async function computeEntitlements(tenantId: string) {
  const subscription = await prisma.subscription.findFirst({
    where: { tenantId, status: "active" },
    include: { plan: true }
  });
  if (!subscription) return null;
  return EntitlementsSchema.parse({
    planCode: subscription.plan.code,
    limits: parseJson(subscription.plan.limits),
    features: parseJson(subscription.plan.features)
  });
}

export async function getEntitlementsForTenant(tenantId: string) {
  return computeEntitlements(tenantId);
}

export async function enforceCameraLimit(tenantId: string) {
  const entitlements = await getEntitlementsForTenant(tenantId);
  if (!entitlements) return;
  const current = await prisma.camera.count({ where: { tenantId, deletedAt: null } });
  const maxAllowed = entitlements.limits.maxCameras;
  if (current >= maxAllowed) {
    const { ApiDomainError } = await import("./types.js");
    throw new ApiDomainError({ statusCode: 409, apiCode: "ENTITLEMENT_LIMIT_EXCEEDED", message: "Camera limit reached for active plan", details: { limit: "maxCameras", current, maxAllowed, tenantId, planCode: entitlements.planCode } });
  }
}

export async function enforceStreamConcurrencyLimit(tenantId: string) {
  const entitlements = await getEntitlementsForTenant(tenantId);
  if (!entitlements) return;
  const now = new Date();
  const inUse = await prisma.streamSession.count({ where: { tenantId, status: { in: ["requested", "issued", "active"] }, expiresAt: { gte: now } } });
  const maxAllowed = entitlements.limits.maxConcurrentStreams;
  if (inUse >= maxAllowed) {
    const { ApiDomainError } = await import("./types.js");
    throw new ApiDomainError({ statusCode: 409, apiCode: "ENTITLEMENT_LIMIT_EXCEEDED", message: "Concurrent stream limit reached for active plan", details: { limit: "maxConcurrentStreams", current: inUse, maxAllowed, tenantId, planCode: entitlements.planCode } });
  }
}

export async function resolveEventsFromDate(tenantId: string, requestedFrom?: Date) {
  const entitlements = await getEntitlementsForTenant(tenantId);
  if (!entitlements) return requestedFrom;
  const minAllowedFrom = new Date(Date.now() - entitlements.limits.retentionDays * 24 * 60 * 60 * 1000);
  if (requestedFrom && requestedFrom < minAllowedFrom) {
    const { ApiDomainError } = await import("./types.js");
    throw new ApiDomainError({ statusCode: 422, apiCode: "ENTITLEMENT_RETENTION_EXCEEDED", message: "Requested date range exceeds plan retention window", details: { limit: "retentionDays", maxAllowedDays: entitlements.limits.retentionDays, minAllowedFrom: minAllowedFrom.toISOString(), requestedFrom: requestedFrom.toISOString(), tenantId, planCode: entitlements.planCode } });
  }
  return requestedFrom ?? minAllowedFrom;
}

// ─── Embedding math ───────────────────────────────────────────────────────────

export function parseEmbeddingCandidate(value: unknown): number[] | null {
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "number") return value as number[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "number") return parsed as number[];
    } catch { /* ignore */ }
  }
  return null;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const len = Math.min(left.length, right.length);
  let dot = 0, normL = 0, normR = 0;
  for (let i = 0; i < len; i++) {
    dot += left[i] * right[i];
    normL += left[i] * left[i];
    normR += right[i] * right[i];
  }
  const denom = Math.sqrt(normL) * Math.sqrt(normR);
  return denom === 0 ? 0 : dot / denom;
}
