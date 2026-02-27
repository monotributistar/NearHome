import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import sensible from "@fastify/sensible";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { LoginInputSchema, RoleSchema } from "@app/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac } from "node:crypto";

type Role = z.infer<typeof RoleSchema>;

type RequestContext = {
  userId: string;
  tenantId?: string;
  role?: Role;
};

type ApiErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

declare module "fastify" {
  interface FastifyRequest {
    ctx?: RequestContext;
    requestId?: string;
    requestStartedAt?: number;
  }
}

const prisma = new PrismaClient();

type LoginBucket = {
  count: number;
  resetAt: number;
};

function statusToCode(statusCode: number): string {
  if (statusCode === 400) return "BAD_REQUEST";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 422) return "UNPROCESSABLE_ENTITY";
  if (statusCode === 429) return "TOO_MANY_REQUESTS";
  return "INTERNAL_SERVER_ERROR";
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function signStreamToken(payload: Record<string, unknown>, secret: string) {
  const serializedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(serializedPayload).digest("base64url");
  return `${serializedPayload}.${signature}`;
}

function toISO(date: Date) {
  return date.toISOString();
}

function parseListQuery(query: Record<string, unknown>) {
  const start = Number(query._start ?? 0);
  const end = Number(query._end ?? start + 10);
  const sort = String(query._sort ?? "createdAt");
  const order = String(query._order ?? "DESC").toLowerCase() === "asc" ? "asc" : "desc";
  return { skip: start, take: Math.max(end - start, 1), sort, order };
}

type DetectorFlags = {
  mediapipe: boolean;
  yolo: boolean;
  lpr: boolean;
};

type ProfileStatus = "pending" | "ready" | "error";
type CameraLifecycleStatus = "draft" | "provisioning" | "ready" | "degraded" | "offline" | "error" | "retired";
type StreamSessionStatus = "requested" | "issued" | "active" | "ended" | "expired";

const CameraLifecycleStatusSchema = z.enum(["draft", "provisioning", "ready", "degraded", "offline", "error", "retired"]);
const CameraConnectivitySchema = z.enum(["online", "degraded", "offline"]);
const StreamSessionStatusSchema = z.enum(["requested", "issued", "active", "ended", "expired"]);

function canTransitionCameraLifecycle(from: CameraLifecycleStatus, to: CameraLifecycleStatus) {
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

function isProfileConfigComplete(profile: {
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

function defaultCameraProfileData(tenantId: string, cameraId: string) {
  return {
    tenantId,
    cameraId,
    proxyPath: `/proxy/live/${tenantId}/${cameraId}`,
    recordingEnabled: false,
    recordingStorageKey: `s3://nearhome/${tenantId}/recordings/${cameraId}`,
    detectorConfigKey: `kv://nearhome/${tenantId}/detectors/${cameraId}/config.json`,
    detectorResultsKey: `s3://nearhome/${tenantId}/detectors/${cameraId}/results`,
    detectorFlags: JSON.stringify({ mediapipe: true, yolo: false, lpr: false } satisfies DetectorFlags),
    status: "ready" as ProfileStatus,
    lastHealthAt: new Date(),
    lastError: null as string | null
  };
}

function profileResponse(profile: {
  id: string;
  tenantId: string;
  cameraId: string;
  proxyPath: string;
  recordingEnabled: boolean;
  recordingStorageKey: string;
  detectorConfigKey: string;
  detectorResultsKey: string;
  detectorFlags: string;
  status: string;
  lastHealthAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const configComplete = isProfileConfigComplete(profile);
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
    status: profile.status as ProfileStatus,
    configComplete,
    lastHealthAt: profile.lastHealthAt ? toISO(profile.lastHealthAt) : null,
    lastError: profile.lastError,
    createdAt: toISO(profile.createdAt),
    updatedAt: toISO(profile.updatedAt)
  };
}

function cameraResponse(camera: {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  rtspUrl: string;
  location: string | null;
  tags: string;
  isActive: boolean;
  lifecycleStatus: string;
  lastSeenAt: Date | null;
  lastTransitionAt: Date | null;
  createdAt: Date;
  profile?: {
    id: string;
    tenantId: string;
    cameraId: string;
    proxyPath: string;
    recordingEnabled: boolean;
    recordingStorageKey: string;
    detectorConfigKey: string;
    detectorResultsKey: string;
    detectorFlags: string;
    status: string;
    lastHealthAt: Date | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
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

function streamSessionResponse(session: {
  id: string;
  tenantId: string;
  cameraId: string;
  userId: string;
  status: string;
  token: string;
  expiresAt: Date;
  issuedAt: Date;
  activatedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  createdAt: Date;
  updatedAt: Date;
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

function canTransitionStreamSession(from: StreamSessionStatus, to: StreamSessionStatus) {
  const allowed: Record<StreamSessionStatus, StreamSessionStatus[]> = {
    requested: ["issued", "ended", "expired"],
    issued: ["active", "ended", "expired"],
    active: ["ended", "expired"],
    ended: [],
    expired: []
  };
  return allowed[from].includes(to);
}

function auditLogResponse(entry: {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  resource: string;
  action: string;
  resourceId: string | null;
  payload: string | null;
  createdAt: Date;
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

async function computeEntitlements(tenantId: string) {
  const subscription = await prisma.subscription.findFirst({
    where: { tenantId, status: "active" },
    include: { plan: true }
  });

  if (!subscription) return null;

  return {
    planCode: subscription.plan.code,
    limits: parseJson(subscription.plan.limits),
    features: parseJson(subscription.plan.features)
  };
}

function assertRole(request: FastifyRequest, roles: Role[]) {
  if (!request.ctx?.role || !roles.includes(request.ctx.role)) {
    throw new Error("FORBIDDEN_ROLE");
  }
}

function getTenantContext(request: FastifyRequest): { userId: string; tenantId: string; role?: Role } {
  if (!request.ctx?.tenantId) {
    throw new Error("MISSING_TENANT");
  }
  return {
    userId: request.ctx.userId,
    tenantId: request.ctx.tenantId,
    role: request.ctx.role
  };
}

async function appendLifecycleLog(args: {
  tenantId: string;
  cameraId: string;
  fromStatus: CameraLifecycleStatus | null;
  toStatus: CameraLifecycleStatus;
  event: string;
  reason?: string | null;
  actorUserId?: string;
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

async function transitionCameraLifecycle(args: {
  tenantId: string;
  cameraId: string;
  toStatus: CameraLifecycleStatus;
  event: string;
  reason?: string | null;
  actorUserId?: string;
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

  await appendLifecycleLog({
    tenantId: args.tenantId,
    cameraId: camera.id,
    fromStatus,
    toStatus: args.toStatus,
    event: args.event,
    reason: args.reason,
    actorUserId: args.actorUserId
  });

  return updated;
}

async function appendStreamSessionTransition(args: {
  streamSessionId: string;
  tenantId: string;
  fromStatus: StreamSessionStatus | null;
  toStatus: StreamSessionStatus;
  event: string;
  actorUserId?: string;
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

async function transitionStreamSession(args: {
  tenantId: string;
  streamSessionId: string;
  toStatus: StreamSessionStatus;
  event: string;
  actorUserId?: string;
  endReason?: string | null;
}) {
  const session = await prisma.streamSession.findFirst({
    where: { id: args.streamSessionId, tenantId: args.tenantId }
  });
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
    streamSessionId: session.id,
    tenantId: args.tenantId,
    fromStatus,
    toStatus: args.toStatus,
    event: args.event,
    actorUserId: args.actorUserId
  });

  return updated;
}

async function expireStaleStreamSessions(tenantId: string) {
  const stale = await prisma.streamSession.findMany({
    where: {
      tenantId,
      status: { in: ["requested", "issued", "active"] },
      expiresAt: { lt: new Date() }
    }
  });
  for (const session of stale) {
    await transitionStreamSession({
      tenantId,
      streamSessionId: session.id,
      toStatus: "expired",
      event: "stream.expired"
    });
  }
}

async function appendAuditLog(args: {
  tenantId: string;
  actorUserId?: string;
  resource: string;
  action: string;
  resourceId?: string;
  payload?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      resource: args.resource,
      action: args.action,
      resourceId: args.resourceId ?? null,
      payload: args.payload ? JSON.stringify(args.payload) : null
    }
  });
}

export async function buildApp() {
  const app = Fastify({ logger: true });
  const jwtSecret = process.env.JWT_SECRET ?? "dev-super-secret";
  const streamTokenSecret = process.env.STREAM_TOKEN_SECRET ?? "dev-stream-token-secret";
  const streamGatewayUrl = process.env.STREAM_GATEWAY_URL?.replace(/\/$/, "") ?? null;
  const loginRateLimitMax = Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 20);
  const loginRateLimitWindowMs = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const readinessForceFail = process.env.READINESS_FORCE_FAIL === "1";
  const loginBuckets = new Map<string, LoginBucket>();

  await app.register(cors, {
    origin: [
      process.env.CORS_ORIGIN_ADMIN ?? "http://localhost:5173",
      process.env.CORS_ORIGIN_PORTAL ?? "http://localhost:5174"
    ],
    credentials: true
  });

  await app.register(jwt, { secret: jwtSecret });
  await app.register(sensible);

  app.addHook("onRequest", async (request, reply) => {
    const incomingRequestId = request.headers["x-request-id"];
    const requestId =
      typeof incomingRequestId === "string" && incomingRequestId.trim().length > 0 ? incomingRequestId.trim() : request.id;
    request.requestId = requestId;
    request.requestStartedAt = Date.now();
    reply.header("x-request-id", requestId);
  });

  app.addHook("onResponse", async (request, reply) => {
    const latencyMs = request.requestStartedAt ? Date.now() - request.requestStartedAt : undefined;
    request.log.info(
      {
        requestId: request.requestId ?? request.id,
        route: request.routeOptions.url,
        method: request.method,
        statusCode: reply.statusCode,
        latencyMs,
        tenantId: request.ctx?.tenantId ?? null,
        userId: request.ctx?.userId ?? null
      },
      "request.summary"
    );
  });

  app.all("/v1/*", async (request, reply) => {
    const targetUrl = request.url.replace(/^\/v1/, "") || "/";
    const proxied = (await app.inject({
      method: request.method as any,
      url: targetUrl,
      headers: request.headers as Record<string, string>,
      payload: request.body as any
    })) as any;

    const ignoredHeaders = new Set(["content-length", "transfer-encoding", "connection"]);
    for (const [key, value] of Object.entries(proxied.headers)) {
      if (!ignoredHeaders.has(key.toLowerCase()) && value !== undefined) {
        reply.header(key, value as string);
      }
    }

    reply.status(proxied.statusCode).send(proxied.body);
  });

  app.setNotFoundHandler((_request, reply) => {
    const body: ApiErrorBody = {
      code: "NOT_FOUND",
      message: "Route not found"
    };
    reply.status(404).send(body);
  });

  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; message?: string; code?: string };
    let statusCode = (err.statusCode ?? 500) as number;

    if (error instanceof z.ZodError) {
      statusCode = 400;
    }
    if (err.message === "MISSING_TENANT") {
      statusCode = 400;
    }
    if (err.message === "FORBIDDEN_ROLE") {
      statusCode = 403;
    }
    if (err.message === "INVALID_LIFECYCLE_TRANSITION") {
      statusCode = 400;
    }
    if (err.message === "CAMERA_NOT_FOUND") {
      statusCode = 404;
    }
    if (err.message === "STREAM_SESSION_NOT_FOUND") {
      statusCode = 404;
    }
    if (err.message === "INVALID_STREAM_SESSION_TRANSITION") {
      statusCode = 400;
    }

    const code = error instanceof z.ZodError ? "VALIDATION_ERROR" : statusToCode(statusCode);
    const defaultMessage = statusCode >= 500 ? "Internal server error" : "Request failed";

    const body: ApiErrorBody = {
      code,
      message:
        err.message === "MISSING_TENANT"
          ? "X-Tenant-Id required"
          : err.message === "FORBIDDEN_ROLE"
            ? "Insufficient permissions"
            : err.message === "INVALID_LIFECYCLE_TRANSITION"
              ? "Invalid camera lifecycle transition"
              : err.message === "CAMERA_NOT_FOUND"
                ? "Camera not found"
                : err.message === "STREAM_SESSION_NOT_FOUND"
                  ? "Stream session not found"
                  : err.message === "INVALID_STREAM_SESSION_TRANSITION"
                    ? "Invalid stream session transition"
            : error instanceof z.ZodError
              ? "Validation failed"
              : err.message || defaultMessage
    };

    if (error instanceof z.ZodError) {
      body.details = error.flatten();
    } else if (err.code === "P2025") {
      body.code = "NOT_FOUND";
      body.message = "Resource not found";
    }

    reply.status(statusCode).send(body);
  });

  const authPreHandler = async (request: FastifyRequest) => {
    await request.jwtVerify<{ userId: string }>();
    const payload = request.user as { userId: string };
    request.ctx = { userId: payload.userId };

    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    if (tenantHeader) {
      const membership = await prisma.membership.findFirst({
        where: {
          tenantId: tenantHeader,
          userId: payload.userId,
          tenant: { deletedAt: null }
        }
      });

      if (!membership) {
        throw app.httpErrors.forbidden("Invalid tenant context");
      }

      request.ctx.tenantId = tenantHeader;
      request.ctx.role = membership.role as Role;
    }
  };

  const tenantScopedPreHandler = async (request: FastifyRequest) => {
    await authPreHandler(request);
    const tenantHeader = request.headers["x-tenant-id"] as string | undefined;
    if (!tenantHeader) {
      throw new Error("MISSING_TENANT");
    }
  };

  const checkLoginRateLimit = (request: FastifyRequest) => {
    const forwarded = request.headers["x-forwarded-for"];
    const ipCandidate = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const key =
      (typeof ipCandidate === "string" ? ipCandidate.split(",")[0]?.trim() : undefined) || request.ip || "unknown";
    const now = Date.now();
    const bucket = loginBuckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      loginBuckets.set(key, { count: 1, resetAt: now + loginRateLimitWindowMs });
      return;
    }

    if (bucket.count >= loginRateLimitMax) {
      throw app.httpErrors.tooManyRequests("Too many login attempts");
    }

    bucket.count += 1;
  };

  app.post("/auth/login", async (request: FastifyRequest, reply: FastifyReply) => {
    checkLoginRateLimit(request);

    const parsed = LoginInputSchema.safeParse(request.body);
    if (!parsed.success) throw parsed.error;

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) throw app.httpErrors.unauthorized("Invalid credentials");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw app.httpErrors.unauthorized("Invalid credentials");

    const token = await reply.jwtSign({ userId: user.id }, { expiresIn: "8h" });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: toISO(user.createdAt),
        isActive: user.isActive
      }
    };
  });

  app.post("/auth/logout", async () => ({ success: true }));

  app.get("/auth/me", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.ctx!.userId } });
    const memberships = await prisma.membership.findMany({
      where: {
        userId: user.id,
        tenant: { deletedAt: null }
      },
      include: { tenant: true }
    });

    const activeTenantId = (request.headers["x-tenant-id"] as string | undefined) ?? memberships[0]?.tenantId;
    const activeTenant = memberships.find((m: any) => m.tenantId === activeTenantId)?.tenant;

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: toISO(user.createdAt),
        isActive: user.isActive
      },
      memberships: memberships.map((m: any) => ({
        id: m.id,
        tenantId: m.tenantId,
        userId: m.userId,
        role: m.role,
        createdAt: toISO(m.createdAt),
        tenant: { id: m.tenant.id, name: m.tenant.name, createdAt: toISO(m.tenant.createdAt) }
      })),
      activeTenant: activeTenant
        ? { id: activeTenant.id, name: activeTenant.name, createdAt: toISO(activeTenant.createdAt) }
        : undefined,
      entitlements: activeTenant ? await computeEntitlements(activeTenant.id) : undefined
    };
  });

  app.get("/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const memberships = await prisma.membership.findMany({
      where: {
        userId: request.ctx!.userId,
        tenant: { deletedAt: null }
      },
      include: { tenant: true }
    });
    const data = memberships.map((m: any) => ({
      id: m.tenant.id,
      name: m.tenant.name,
      createdAt: toISO(m.tenant.createdAt)
    }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const body = z.object({ name: z.string().min(2) }).parse(request.body);
    const tenant = await prisma.tenant.create({ data: { name: body.name } });
    await prisma.membership.create({
      data: { tenantId: tenant.id, userId: request.ctx!.userId, role: "tenant_admin" }
    });
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.get("/tenants/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    const membership = await prisma.membership.findFirst({
      where: {
        tenantId: id,
        userId: request.ctx!.userId,
        tenant: { deletedAt: null }
      }
    });
    if (!membership) throw app.httpErrors.forbidden();
    const tenant = await prisma.tenant.findFirst({ where: { id, deletedAt: null } });
    if (!tenant) throw app.httpErrors.notFound();
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.put("/tenants/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    const body = z.object({ name: z.string().min(2) }).parse(request.body);
    const membership = await prisma.membership.findFirst({
      where: {
        tenantId: id,
        userId: request.ctx!.userId,
        tenant: { deletedAt: null }
      }
    });
    if (!membership || membership.role !== "tenant_admin") throw app.httpErrors.forbidden();
    const tenant = await prisma.tenant.update({ where: { id }, data: { name: body.name } });
    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.delete("/tenants/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    const membership = await prisma.membership.findFirst({
      where: {
        tenantId: id,
        userId: request.ctx!.userId,
        role: "tenant_admin",
        tenant: { deletedAt: null }
      }
    });
    if (!membership) throw app.httpErrors.forbidden();

    const tenant = await prisma.tenant.update({
      where: { id },
      data: { deletedAt: new Date() }
    });

    await appendAuditLog({
      tenantId: id,
      actorUserId: request.ctx!.userId,
      resource: "tenant",
      action: "delete",
      resourceId: id,
      payload: { name: tenant.name }
    });

    return { data: { id: tenant.id, name: tenant.name, createdAt: toISO(tenant.createdAt) } };
  });

  app.get("/users", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor"]);
    const memberships = await prisma.membership.findMany({
      where: { tenantId: ctx.tenantId },
      include: { user: true }
    });
    const data = memberships.map((m: any) => ({
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      createdAt: toISO(m.user.createdAt),
      isActive: m.user.isActive,
      role: m.role
    }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/users", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const body = z
      .object({ email: z.string().email(), name: z.string(), password: z.string().min(4), role: RoleSchema })
      .parse(request.body);

    const hash = await bcrypt.hash(body.password, 10);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    const user = existing
      ? existing
      : await prisma.user.create({ data: { email: body.email, name: body.name, passwordHash: hash, isActive: true } });

    await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: user.id } },
      update: { role: body.role },
      create: { tenantId: ctx.tenantId, userId: user.id, role: body.role }
    });

    return {
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: toISO(user.createdAt),
        isActive: user.isActive
      }
    };
  });

  app.put("/users/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        name: z.string().min(1).optional(),
        isActive: z.boolean().optional(),
        role: RoleSchema.optional()
      })
      .refine((value) => value.name !== undefined || value.isActive !== undefined || value.role !== undefined, {
        message: "At least one field must be provided"
      })
      .parse(request.body);

    const membership = await prisma.membership.findFirst({
      where: { tenantId: ctx.tenantId, userId: id },
      include: { user: true }
    });
    if (!membership) throw app.httpErrors.notFound("User not found in tenant");

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {})
      }
    });

    if (body.role) {
      await prisma.membership.update({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId: id } },
        data: { role: body.role }
      });
    }

    const updatedMembership = await prisma.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: id } }
    });

    return {
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: toISO(user.createdAt),
        isActive: user.isActive,
        role: updatedMembership.role
      }
    };
  });

  app.get(
    "/memberships",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ctx = getTenantContext(request);
      assertRole(request, ["tenant_admin", "monitor"]);
      const rows = await prisma.membership.findMany({ where: { tenantId: ctx.tenantId }, include: { user: true } });
      const data = rows.map((m: any) => ({
        id: m.id,
        tenantId: m.tenantId,
        userId: m.userId,
        role: m.role,
        createdAt: toISO(m.createdAt),
        user: {
          id: m.user.id,
          email: m.user.email,
          name: m.user.name,
          createdAt: toISO(m.user.createdAt),
          isActive: m.user.isActive
        }
      }));
      reply.header("x-total-count", String(data.length));
      return { data, total: data.length };
    }
  );

  app.post("/memberships", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const body = z.object({ userId: z.string(), role: RoleSchema }).parse(request.body);
    const membership = await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: body.userId } },
      update: { role: body.role },
      create: { tenantId: ctx.tenantId, userId: body.userId, role: body.role }
    });
    return {
      data: {
        id: membership.id,
        tenantId: membership.tenantId,
        userId: membership.userId,
        role: membership.role,
        createdAt: toISO(membership.createdAt)
      }
    };
  });

  app.get("/audit-logs", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const query = request.query as Record<string, unknown>;
    const { skip, take } = parseListQuery(query);
    const resource = typeof query.resource === "string" ? query.resource : undefined;
    const action = typeof query.action === "string" ? query.action : undefined;

    const where = {
      tenantId: ctx.tenantId,
      ...(resource ? { resource } : {}),
      ...(action ? { action } : {})
    };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" }
      }),
      prisma.auditLog.count({ where })
    ]);

    reply.header("x-total-count", String(total));
    return { data: rows.map(auditLogResponse), total };
  });

  app.get("/cameras", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);

    const { skip, take, sort, order } = parseListQuery(request.query as Record<string, unknown>);
    const q = request.query as Record<string, unknown>;

    const where: any = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      ...(q.name ? { name: { contains: String(q.name), mode: "insensitive" } } : {}),
      ...(q.isActive !== undefined ? { isActive: String(q.isActive) === "true" } : {})
    };

    const [rows, total] = await Promise.all([
      prisma.camera.findMany({ where, skip, take, orderBy: { [sort]: order }, include: { profile: true } }),
      prisma.camera.count({ where })
    ]);

    const data = rows.map(cameraResponse);
    reply.header("x-total-count", String(total));
    return { data, total };
  });

  app.post("/cameras", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const body = z
      .object({
        name: z.string().min(2),
        description: z.string().max(2000).optional(),
        rtspUrl: z.string().min(4),
        location: z.string().optional(),
        tags: z.array(z.string()).optional(),
        isActive: z.boolean().default(true)
      })
      .parse(request.body);

    const camera = await prisma.camera.create({
      data: {
        tenantId: ctx.tenantId,
        name: body.name,
        description: body.description,
        rtspUrl: body.rtspUrl,
        location: body.location,
        tags: JSON.stringify(body.tags ?? []),
        isActive: body.isActive,
        lifecycleStatus: body.isActive ? "provisioning" : "draft",
        lastTransitionAt: new Date()
      }
    });

    await appendLifecycleLog({
      tenantId: ctx.tenantId,
      cameraId: camera.id,
      fromStatus: null,
      toStatus: camera.lifecycleStatus as CameraLifecycleStatus,
      event: "camera.created",
      reason: body.isActive ? "active camera queued for provisioning" : "created in draft mode",
      actorUserId: ctx.userId
    });

    if (camera.isActive) {
      await prisma.cameraProfile.upsert({
        where: { cameraId: camera.id },
        update: {},
        create: defaultCameraProfileData(ctx.tenantId, camera.id)
      });
      await appendLifecycleLog({
        tenantId: ctx.tenantId,
        cameraId: camera.id,
        fromStatus: "provisioning",
        toStatus: "provisioning",
        event: "camera.profile_configured",
        reason: "profile auto-provisioned",
        actorUserId: ctx.userId
      });
    }

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "create",
      resourceId: camera.id,
      payload: {
        name: camera.name,
        isActive: camera.isActive,
        lifecycleStatus: camera.lifecycleStatus
      }
    });

    const withProfile = await prisma.camera.findUniqueOrThrow({ where: { id: camera.id }, include: { profile: true } });
    return { data: cameraResponse(withProfile) };
  });

  app.get("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    const id = (request.params as { id: string }).id;
    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: { profile: true }
    });
    if (!camera) throw app.httpErrors.notFound();
    return { data: cameraResponse(camera) };
  });

  app.put("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        name: z.string().min(2),
        description: z.string().max(2000).optional().nullable(),
        rtspUrl: z.string().min(4),
        location: z.string().optional().nullable(),
        tags: z.array(z.string()).optional(),
        isActive: z.boolean().default(true)
      })
      .parse(request.body);

    const current = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!current) throw new Error("CAMERA_NOT_FOUND");

    const camera = await prisma.camera.update({
      where: { id: current.id },
      data: {
        name: body.name,
        description: body.description,
        rtspUrl: body.rtspUrl,
        location: body.location,
        tags: JSON.stringify(body.tags ?? []),
        isActive: body.isActive
      }
    });

    if (camera.isActive) {
      await prisma.cameraProfile.upsert({
        where: { cameraId: camera.id },
        update: {},
        create: defaultCameraProfileData(camera.tenantId, camera.id)
      });
      if ((camera.lifecycleStatus as CameraLifecycleStatus) === "draft") {
        await transitionCameraLifecycle({
          tenantId: camera.tenantId,
          cameraId: camera.id,
          toStatus: "provisioning",
          event: "camera.reactivated_for_provisioning",
          reason: "camera set active from draft",
          actorUserId: ctx.userId
        });
      }
    }

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "update",
      resourceId: camera.id,
      payload: {
        name: camera.name,
        isActive: camera.isActive,
        lifecycleStatus: camera.lifecycleStatus
      }
    });

    const withProfile = await prisma.camera.findUniqueOrThrow({ where: { id: camera.id }, include: { profile: true } });
    return { data: cameraResponse(withProfile) };
  });

  app.delete("/cameras/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");
    const deleted = await prisma.camera.update({ where: { id: camera.id }, data: { deletedAt: new Date() } });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "delete",
      resourceId: camera.id,
      payload: {
        name: camera.name,
        lifecycleStatus: camera.lifecycleStatus
      }
    });

    if (streamGatewayUrl) {
      try {
        await fetch(`${streamGatewayUrl}/deprovision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantId: ctx.tenantId, cameraId: camera.id })
        });
      } catch (error) {
        request.log.warn({ error, tenantId: ctx.tenantId, cameraId: camera.id }, "stream_gateway.deprovision_failed");
      }
    }
    return { data: cameraResponse(deleted) };
  });

  app.post("/cameras/:id/stream-token", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw app.httpErrors.notFound();

    await expireStaleStreamSessions(ctx.tenantId);

    const expiresAt = new Date(Date.now() + 1000 * 60 * 5);
    const requested = await prisma.streamSession.create({
      data: {
        tenantId: ctx.tenantId,
        cameraId: id,
        userId: ctx.userId,
        status: "requested",
        token: "",
        expiresAt,
        issuedAt: new Date()
      }
    });
    await appendStreamSessionTransition({
      streamSessionId: requested.id,
      tenantId: ctx.tenantId,
      fromStatus: null,
      toStatus: "requested",
      event: "stream.requested",
      actorUserId: ctx.userId
    });
    const token = signStreamToken(
      {
        sub: ctx.userId,
        tid: ctx.tenantId,
        cid: id,
        sid: requested.id,
        exp: Math.floor(expiresAt.getTime() / 1000),
        iat: Math.floor(Date.now() / 1000),
        v: 1
      },
      streamTokenSecret
    );
    const session = await transitionStreamSession({
      tenantId: ctx.tenantId,
      streamSessionId: requested.id,
      toStatus: "issued",
      event: "stream.issued",
      actorUserId: ctx.userId
    });
    const sessionWithToken = await prisma.streamSession.update({
      where: { id: session.id },
      data: { token }
    });

    let playbackUrl: string | undefined;
    if (streamGatewayUrl) {
      try {
        await fetch(`${streamGatewayUrl}/provision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tenantId: ctx.tenantId,
            cameraId: id,
            rtspUrl: camera.rtspUrl
          })
        });
        playbackUrl = `${streamGatewayUrl}/playback/${ctx.tenantId}/${id}/index.m3u8?token=${encodeURIComponent(token)}`;
      } catch (error) {
        request.log.warn({ error, tenantId: ctx.tenantId, cameraId: id }, "stream_gateway.provision_failed");
      }
    }

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      session: streamSessionResponse(sessionWithToken),
      ...(playbackUrl ? { playbackUrl } : {})
    };
  });

  app.get("/stream-sessions", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);

    const query = request.query as Record<string, unknown>;
    const { skip, take, sort, order } = parseListQuery(query);
    const cameraId = typeof query.cameraId === "string" ? query.cameraId : undefined;
    const status = StreamSessionStatusSchema.safeParse(query.status);

    const where = {
      tenantId: ctx.tenantId,
      ...(cameraId ? { cameraId } : {}),
      ...(status.success ? { status: status.data } : {}),
      ...(ctx.role === "client_user" ? { userId: ctx.userId } : {})
    };

    const [data, total] = await Promise.all([
      prisma.streamSession.findMany({
        where,
        skip,
        take,
        orderBy: { [sort]: order }
      }),
      prisma.streamSession.count({ where })
    ]);

    reply.header("x-total-count", String(total));
    return { data: data.map(streamSessionResponse), total };
  });

  app.get("/stream-sessions/:id", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);

    const id = (request.params as { id: string }).id;
    const session = await prisma.streamSession.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        ...(ctx.role === "client_user" ? { userId: ctx.userId } : {})
      }
    });
    if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");

    const transitions = await prisma.streamSessionTransition.findMany({
      where: { streamSessionId: session.id },
      orderBy: { createdAt: "desc" },
      take: 30
    });
    return {
      data: {
        ...streamSessionResponse(session),
        history: transitions.map((entry) => ({
          id: entry.id,
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          event: entry.event,
          actorUserId: entry.actorUserId,
          createdAt: toISO(entry.createdAt)
        }))
      }
    };
  });

  app.post("/stream-sessions/:id/activate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);

    const id = (request.params as { id: string }).id;
    const session = await prisma.streamSession.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId
      }
    });
    if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");
    if (ctx.role === "client_user" && session.userId !== ctx.userId) {
      throw app.httpErrors.forbidden("Stream session ownership mismatch");
    }

    const updated = await transitionStreamSession({
      tenantId: ctx.tenantId,
      streamSessionId: id,
      toStatus: "active",
      event: "stream.activated",
      actorUserId: ctx.userId
    });
    return { data: streamSessionResponse(updated) };
  });

  app.post("/stream-sessions/:id/end", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    await expireStaleStreamSessions(ctx.tenantId);

    const id = (request.params as { id: string }).id;
    const body = z.object({ reason: z.string().optional() }).parse(request.body ?? {});
    const session = await prisma.streamSession.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId
      }
    });
    if (!session) throw new Error("STREAM_SESSION_NOT_FOUND");
    if (ctx.role === "client_user" && session.userId !== ctx.userId) {
      throw app.httpErrors.forbidden("Stream session ownership mismatch");
    }

    const updated = await transitionStreamSession({
      tenantId: ctx.tenantId,
      streamSessionId: id,
      toStatus: "ended",
      event: "stream.ended",
      actorUserId: ctx.userId,
      endReason: body.reason ?? "ended by user action"
    });
    return { data: streamSessionResponse(updated) };
  });

  app.get("/cameras/:id/profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;
    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw app.httpErrors.notFound();

    const profile = await prisma.cameraProfile.upsert({
      where: { cameraId: id },
      update: {},
      create: defaultCameraProfileData(ctx.tenantId, id)
    });
    return { data: profileResponse(profile) };
  });

  app.put("/cameras/:id/profile", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        proxyPath: z.string().optional(),
        recordingEnabled: z.boolean().optional(),
        recordingStorageKey: z.string().optional(),
        detectorConfigKey: z.string().optional(),
        detectorResultsKey: z.string().optional(),
        detectorFlags: z
          .object({
            mediapipe: z.boolean(),
            yolo: z.boolean(),
            lpr: z.boolean()
          })
          .optional(),
        status: z.enum(["pending", "ready", "error"]).optional(),
        lastHealthAt: z.string().datetime().nullable().optional(),
        lastError: z.string().nullable().optional()
      })
      .refine(
        (value) =>
          value.proxyPath !== undefined ||
          value.recordingEnabled !== undefined ||
          value.recordingStorageKey !== undefined ||
          value.detectorConfigKey !== undefined ||
          value.detectorResultsKey !== undefined ||
          value.detectorFlags !== undefined ||
          value.status !== undefined ||
          value.lastHealthAt !== undefined ||
          value.lastError !== undefined,
        { message: "At least one profile field must be provided" }
      )
      .parse(request.body);

    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw app.httpErrors.notFound();

    const profile = await prisma.cameraProfile.upsert({
      where: { cameraId: id },
      update: {
        ...(body.proxyPath !== undefined ? { proxyPath: body.proxyPath } : {}),
        ...(body.recordingEnabled !== undefined ? { recordingEnabled: body.recordingEnabled } : {}),
        ...(body.recordingStorageKey !== undefined ? { recordingStorageKey: body.recordingStorageKey } : {}),
        ...(body.detectorConfigKey !== undefined ? { detectorConfigKey: body.detectorConfigKey } : {}),
        ...(body.detectorResultsKey !== undefined ? { detectorResultsKey: body.detectorResultsKey } : {}),
        ...(body.detectorFlags !== undefined ? { detectorFlags: JSON.stringify(body.detectorFlags) } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.lastHealthAt !== undefined ? { lastHealthAt: body.lastHealthAt ? new Date(body.lastHealthAt) : null } : {}),
        ...(body.lastError !== undefined ? { lastError: body.lastError } : {})
      },
      create: {
        ...defaultCameraProfileData(ctx.tenantId, id),
        ...(body.proxyPath !== undefined ? { proxyPath: body.proxyPath } : {}),
        ...(body.recordingEnabled !== undefined ? { recordingEnabled: body.recordingEnabled } : {}),
        ...(body.recordingStorageKey !== undefined ? { recordingStorageKey: body.recordingStorageKey } : {}),
        ...(body.detectorConfigKey !== undefined ? { detectorConfigKey: body.detectorConfigKey } : {}),
        ...(body.detectorResultsKey !== undefined ? { detectorResultsKey: body.detectorResultsKey } : {}),
        ...(body.detectorFlags !== undefined ? { detectorFlags: JSON.stringify(body.detectorFlags) } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.lastHealthAt !== undefined ? { lastHealthAt: body.lastHealthAt ? new Date(body.lastHealthAt) : null } : {}),
        ...(body.lastError !== undefined ? { lastError: body.lastError } : {})
      }
    });

    const configComplete = isProfileConfigComplete(profile);
    if (!configComplete && profile.status === "ready") {
      const normalized = await prisma.cameraProfile.update({
        where: { cameraId: id },
        data: {
          status: "pending",
          lastError: profile.lastError ?? "incomplete profile configuration"
        }
      });
      await appendAuditLog({
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        resource: "camera_profile",
        action: "update",
        resourceId: id,
        payload: {
          status: normalized.status,
          configComplete: false
        }
      });
      return { data: profileResponse(normalized) };
    }

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera_profile",
      action: "update",
      resourceId: id,
      payload: {
        status: profile.status,
        configComplete
      }
    });

    return { data: profileResponse(profile) };
  });

  app.get("/cameras/:id/lifecycle", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);
    const id = (request.params as { id: string }).id;

    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null }
    });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");

    const [snapshot, logs] = await Promise.all([
      prisma.cameraHealthSnapshot.findUnique({ where: { cameraId: id } }),
      prisma.cameraLifecycleLog.findMany({ where: { cameraId: id }, orderBy: { createdAt: "desc" }, take: 100 })
    ]);

    return {
      data: {
        cameraId: id,
        currentStatus: camera.lifecycleStatus,
        isActive: camera.isActive,
        lastSeenAt: camera.lastSeenAt ? toISO(camera.lastSeenAt) : null,
        lastTransitionAt: camera.lastTransitionAt ? toISO(camera.lastTransitionAt) : null,
        healthSnapshot: snapshot
          ? {
              id: snapshot.id,
              connectivity: snapshot.connectivity,
              latencyMs: snapshot.latencyMs,
              packetLossPct: snapshot.packetLossPct,
              jitterMs: snapshot.jitterMs,
              error: snapshot.error,
              checkedAt: toISO(snapshot.checkedAt)
            }
          : null,
        history: logs.map((log) => ({
          id: log.id,
          fromStatus: log.fromStatus,
          toStatus: log.toStatus,
          event: log.event,
          reason: log.reason,
          actorUserId: log.actorUserId,
          createdAt: toISO(log.createdAt)
        }))
      }
    };
  });

  app.post("/cameras/:id/validate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z.object({ simulate: z.enum(["pass", "fail"]).optional() }).parse(request.body ?? {});

    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: { profile: true }
    });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");

    const profile =
      camera.profile ??
      (await prisma.cameraProfile.upsert({
        where: { cameraId: id },
        update: {},
        create: defaultCameraProfileData(ctx.tenantId, id)
      }));

    const shouldPass = body.simulate
      ? body.simulate === "pass"
      : isProfileConfigComplete({
          proxyPath: profile.proxyPath,
          recordingStorageKey: profile.recordingStorageKey,
          detectorConfigKey: profile.detectorConfigKey,
          detectorResultsKey: profile.detectorResultsKey
        });

    const nextStatus: CameraLifecycleStatus = shouldPass ? "ready" : "error";
    const transitioned = await transitionCameraLifecycle({
      tenantId: ctx.tenantId,
      cameraId: id,
      toStatus: nextStatus,
      event: shouldPass ? "camera.validation_passed" : "camera.validation_failed",
      reason: shouldPass ? "validation succeeded" : "validation failed",
      actorUserId: ctx.userId
    });

    await prisma.cameraHealthSnapshot.upsert({
      where: { cameraId: id },
      update: {
        connectivity: shouldPass ? "online" : "offline",
        latencyMs: shouldPass ? 95 : null,
        packetLossPct: shouldPass ? 0.1 : null,
        jitterMs: shouldPass ? 6 : null,
        error: shouldPass ? null : "validation failed",
        checkedAt: new Date()
      },
      create: {
        tenantId: ctx.tenantId,
        cameraId: id,
        connectivity: shouldPass ? "online" : "offline",
        latencyMs: shouldPass ? 95 : null,
        packetLossPct: shouldPass ? 0.1 : null,
        jitterMs: shouldPass ? 6 : null,
        error: shouldPass ? null : "validation failed",
        checkedAt: new Date()
      }
    });

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: shouldPass ? "validate_pass" : "validate_fail",
      resourceId: id,
      payload: {
        lifecycleStatus: transitioned.lifecycleStatus
      }
    });

    return { data: cameraResponse(transitioned) };
  });

  app.post("/cameras/:id/retire", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;

    const transitioned = await transitionCameraLifecycle({
      tenantId: ctx.tenantId,
      cameraId: id,
      toStatus: "retired",
      event: "camera.retired",
      reason: "retired by admin",
      actorUserId: ctx.userId
    });

    const deactivated = await prisma.camera.update({
      where: { id },
      data: { isActive: false },
      include: { profile: true }
    });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "retire",
      resourceId: id,
      payload: {
        lifecycleStatus: transitioned.lifecycleStatus,
        isActive: false
      }
    });

    return { data: cameraResponse({ ...deactivated, lifecycleStatus: transitioned.lifecycleStatus }) };
  });

  app.post("/cameras/:id/reactivate", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;

    const transitioned = await transitionCameraLifecycle({
      tenantId: ctx.tenantId,
      cameraId: id,
      toStatus: "draft",
      event: "camera.reactivated",
      reason: "reactivated by admin",
      actorUserId: ctx.userId
    });

    const activated = await prisma.camera.update({
      where: { id },
      data: { isActive: true },
      include: { profile: true }
    });
    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "reactivate",
      resourceId: id,
      payload: {
        lifecycleStatus: transitioned.lifecycleStatus,
        isActive: true
      }
    });

    return { data: cameraResponse({ ...activated, lifecycleStatus: transitioned.lifecycleStatus }) };
  });

  app.post("/cameras/:id/health", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest) => {
    const ctx = getTenantContext(request);
    assertRole(request, ["tenant_admin"]);
    const id = (request.params as { id: string }).id;
    const body = z
      .object({
        connectivity: CameraConnectivitySchema,
        latencyMs: z.number().int().nullable().optional(),
        packetLossPct: z.number().min(0).max(100).nullable().optional(),
        jitterMs: z.number().int().nullable().optional(),
        error: z.string().nullable().optional()
      })
      .parse(request.body);

    const camera = await prisma.camera.findFirst({ where: { id, tenantId: ctx.tenantId, deletedAt: null } });
    if (!camera) throw new Error("CAMERA_NOT_FOUND");

    await prisma.cameraHealthSnapshot.upsert({
      where: { cameraId: id },
      update: {
        connectivity: body.connectivity,
        latencyMs: body.latencyMs ?? null,
        packetLossPct: body.packetLossPct ?? null,
        jitterMs: body.jitterMs ?? null,
        error: body.error ?? null,
        checkedAt: new Date()
      },
      create: {
        tenantId: ctx.tenantId,
        cameraId: id,
        connectivity: body.connectivity,
        latencyMs: body.latencyMs ?? null,
        packetLossPct: body.packetLossPct ?? null,
        jitterMs: body.jitterMs ?? null,
        error: body.error ?? null,
        checkedAt: new Date()
      }
    });

    const lifecycleStatus: CameraLifecycleStatus =
      body.connectivity === "online" ? "ready" : body.connectivity === "degraded" ? "degraded" : "offline";

    const transitioned = await transitionCameraLifecycle({
      tenantId: ctx.tenantId,
      cameraId: id,
      toStatus: lifecycleStatus,
      event: "camera.health_updated",
      reason: `connectivity=${body.connectivity}`,
      actorUserId: ctx.userId
    });

    await appendAuditLog({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      resource: "camera",
      action: "health_update",
      resourceId: id,
      payload: {
        connectivity: body.connectivity,
        lifecycleStatus: transitioned.lifecycleStatus
      }
    });

    return { data: cameraResponse(transitioned) };
  });

  app.get("/plans", { preHandler: authPreHandler }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const plans = await prisma.plan.findMany({ orderBy: { createdAt: "asc" } });
    const data = plans.map((p: any) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      limits: parseJson(p.limits),
      features: parseJson(p.features)
    }));
    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.post("/tenants/:id/subscription", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const tenantId = (request.params as { id: string }).id;
    const membership = await prisma.membership.findFirst({ where: { userId: request.ctx!.userId, tenantId } });
    if (!membership || membership.role !== "tenant_admin") throw app.httpErrors.forbidden();

    const body = z.object({ planId: z.string() }).parse(request.body);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { id: body.planId } });

    const subscription = await prisma.subscription.upsert({
      where: { tenantId },
      update: {
        planId: plan.id,
        status: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
      },
      create: {
        tenantId,
        planId: plan.id,
        status: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
      },
      include: { plan: true }
    });

    await appendAuditLog({
      tenantId,
      actorUserId: request.ctx!.userId,
      resource: "subscription",
      action: "set_plan",
      resourceId: subscription.id,
      payload: {
        planId: subscription.planId,
        status: subscription.status
      }
    });

    return {
      data: {
        id: subscription.id,
        tenantId: subscription.tenantId,
        planId: subscription.planId,
        status: subscription.status,
        currentPeriodStart: toISO(subscription.currentPeriodStart),
        currentPeriodEnd: toISO(subscription.currentPeriodEnd),
        plan: {
          id: subscription.plan.id,
          code: subscription.plan.code,
          name: subscription.plan.name,
          limits: parseJson(subscription.plan.limits),
          features: parseJson(subscription.plan.features)
        }
      }
    };
  });

  app.get("/tenants/:id/entitlements", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const tenantId = (request.params as { id: string }).id;
    const membership = await prisma.membership.findFirst({ where: { userId: request.ctx!.userId, tenantId } });
    if (!membership) throw app.httpErrors.forbidden();

    const entitlements = await computeEntitlements(tenantId);
    return { data: entitlements };
  });

  app.get(
    "/subscriptions",
    { preHandler: tenantScopedPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getTenantContext(request);
      const row = await prisma.subscription.findFirst({ where: { tenantId }, include: { plan: true } });

      const data = row
        ? [
            {
              id: row.id,
              tenantId: row.tenantId,
              planId: row.planId,
              status: row.status,
              currentPeriodStart: toISO(row.currentPeriodStart),
              currentPeriodEnd: toISO(row.currentPeriodEnd),
              plan: {
                id: row.plan.id,
                code: row.plan.code,
                name: row.plan.name,
                limits: parseJson(row.plan.limits),
                features: parseJson(row.plan.features)
              }
            }
          ]
        : [];

      reply.header("x-total-count", String(data.length));
      return { data, total: data.length };
    }
  );

  app.get("/events", { preHandler: tenantScopedPreHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenantId } = getTenantContext(request);
    assertRole(request, ["tenant_admin", "monitor", "client_user"]);

    const q = request.query as Record<string, string | undefined>;
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;

    const rows = await prisma.event.findMany({
      where: {
        tenantId,
        ...(q.cameraId ? { cameraId: q.cameraId } : {}),
        ...(from || to
          ? {
              timestamp: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {})
              }
            }
          : {})
      },
      orderBy: { timestamp: "desc" },
      take: 200
    });

    const data = rows.map((e: any) => ({
      id: e.id,
      tenantId: e.tenantId,
      cameraId: e.cameraId,
      type: e.type,
      severity: e.severity,
      timestamp: toISO(e.timestamp),
      payload: parseJson(e.payload)
    }));

    reply.header("x-total-count", String(data.length));
    return { data, total: data.length };
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/readiness", async (request, reply) => {
    if (readinessForceFail) {
      reply.status(503);
      return {
        ok: false,
        db: "down",
        reason: "forced_failure",
        timestamp: new Date().toISOString(),
        requestId: request.requestId ?? request.id
      };
    }

    try {
      await prisma.$queryRaw`SELECT 1`;
      return {
        ok: true,
        db: "up",
        timestamp: new Date().toISOString(),
        requestId: request.requestId ?? request.id
      };
    } catch {
      reply.status(503);
      return {
        ok: false,
        db: "down",
        reason: "db_unreachable",
        timestamp: new Date().toISOString(),
        requestId: request.requestId ?? request.id
      };
    }
  });

  return app;
}
