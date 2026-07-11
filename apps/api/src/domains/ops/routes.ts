import { z } from "zod";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { AppMiddleware } from "../../core/middleware.js";
import { prisma } from "../../core/prisma.js";
import { parseJson } from "../../core/utils.js";
import { ApiDomainError } from "../../core/types.js";
import { snapshotResponse, modelCatalogEntryResponse, nodeObservedConfigResponse } from "../../core/responses.js";
import { DetectionQualitySchema } from "../detection/service.js";

export type OpsPluginOptions = {
  middleware: AppMiddleware;
  inferenceBridgeUrl: string;
  nodeAuthAdminSecret: string;
  streamGatewayUrl: string | null;
  eventGatewayUrl: string | null;
  temporalDispatchUrl: string | null;
  detectionDeployOutputPath: string;
  repoRoot: string;
  detectionStackSyncCommand?: string | null;
  detectionStackSyncTimeoutMs?: number;
  detectionStackSyncMaxRetries?: number;
  detectionStackSyncRetryDelayMs?: number;
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const DesiredNodeCapabilitySchema = z.object({
  capabilityId: z.string(),
  taskTypes: z.array(z.string()).default([]),
  qualities: z.array(DetectionQualitySchema).default([]),
  modelRefs: z.array(z.string()).default([])
});

const ModelCatalogEntryInputSchema = z.object({
  provider: z.string().min(1),
  taskType: z.string().min(1),
  quality: DetectionQualitySchema,
  modelRef: z.string().min(1),
  displayName: z.string().min(1),
  resources: z.record(z.number()).default({ cpu: 1, gpu: 0, vramMb: 0 }),
  defaults: z.record(z.any()).optional(),
  outputs: z.record(z.any()).optional(),
  status: z.enum(["active", "disabled"]).default("active")
});

// ─── Stack sync state (module-level mutable) ──────────────────────────────────

type DetectionStackSyncState = {
  status: "idle" | "running" | "succeeded" | "failed";
  mode: string | null;
  profile: string | null;
  attempt: number;
  maxAttempts: number;
  timeoutMs: number;
  retryDelayMs: number;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  command: string | null;
  logTail: string[];
  errorMessage: string | null;
};

let detectionStackSyncState: DetectionStackSyncState = {
  status: "idle",
  mode: null,
  profile: null,
  attempt: 0,
  maxAttempts: 1,
  timeoutMs: 60000,
  retryDelayMs: 5000,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  command: null,
  logTail: [],
  errorMessage: null
};
let detectionStackSyncRunId = 0;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function normalizeDesiredNodeConfig(args: {
  nodeId: string;
  runtime: string;
  transport: string;
  endpoint: string;
  desiredResources: string;
  desiredModels: string;
  desiredCapabilities: string;
  desiredTenantIds: string;
  maxConcurrent: number;
  contractVersion: string;
  configVersion: number;
  lastAppliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    nodeId: args.nodeId,
    runtime: args.runtime,
    transport: args.transport,
    endpoint: args.endpoint,
    resources: parseJson<Record<string, number>>(args.desiredResources),
    capabilities: parseJson<Array<Record<string, unknown>>>(args.desiredCapabilities).map(
      normalizeDesiredNodeCapability
    ),
    models: parseJson<string[]>(args.desiredModels),
    tenantIds: parseJson<string[]>(args.desiredTenantIds),
    maxConcurrent: args.maxConcurrent,
    contractVersion: args.contractVersion,
    configVersion: args.configVersion,
    lastAppliedAt: args.lastAppliedAt ? args.lastAppliedAt.toISOString() : null,
    createdAt: args.createdAt.toISOString(),
    updatedAt: args.updatedAt.toISOString()
  };
}

function normalizeDesiredNodeCapability(raw: Record<string, unknown>, index: number) {
  const parsed = DesiredNodeCapabilitySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return {
    capabilityId: typeof raw.capabilityId === "string" ? raw.capabilityId : `cap-${index}`,
    taskTypes: [],
    qualities: [] as string[],
    modelRefs: []
  };
}

function buildNodeConfigDiff(args: {
  desired: ReturnType<typeof normalizeDesiredNodeConfig> | null;
  observed: {
    runtime: string;
    transport: string;
    endpoint: string;
    resources: Record<string, number>;
    capabilities: any[];
    models: string[];
    assignedTenantIds: string[];
    maxConcurrent: number;
  } | null;
}) {
  if (!args.desired || !args.observed)
    return {
      inSync: false,
      items: [{ field: "presence", desired: Boolean(args.desired), observed: Boolean(args.observed) }]
    };
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

function extractPortFromEndpoint(endpoint: string, fallbackPort: number) {
  try {
    const url = new URL(endpoint);
    if (url.port) return Number(url.port);
  } catch {}
  return fallbackPort;
}

function buildNodeDeployDefinition(args: {
  nodeId: string;
  desired: ReturnType<typeof normalizeDesiredNodeConfig> | null;
  observed: ReturnType<typeof nodeObservedConfigResponse> | null;
}) {
  const source = args.desired ? "desired" : "observed";
  const base = args.desired ?? args.observed;
  if (!base) return null;
  const runtime = base.runtime;
  const fallbackPort = runtime === "mediapipe" ? 8092 : 8091;
  const port = extractPortFromEndpoint(base.endpoint, fallbackPort);
  const capabilityList = Array.isArray(base.capabilities) ? base.capabilities : [];
  const taskTypes = Array.from(
    new Set(
      capabilityList.flatMap((c: any) => c.taskTypes ?? []).filter((v: unknown): v is string => typeof v === "string")
    )
  );
  const modelRefs = Array.from(
    new Set(
      [
        ...((Array.isArray(base.models) ? base.models : []) as string[]),
        ...capabilityList.flatMap((c: any) => c.modelRefs ?? c.models ?? [])
      ].filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  );
  const tenantIds =
    "tenantIds" in base && Array.isArray(base.tenantIds)
      ? base.tenantIds
      : "assignedTenantIds" in base && Array.isArray((base as any).assignedTenantIds)
        ? (base as any).assignedTenantIds
        : [];
  const serviceName = `inference-node-${runtime}-${args.nodeId.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
  const buildContext = runtime === "mediapipe" ? "../apps/inference-node-mediapipe" : "../apps/inference-node-yolo";
  const env = {
    INFERENCE_BRIDGE_URL: "http://inference-bridge:8090",
    NODE_ID: args.nodeId,
    NODE_RUNTIME: runtime,
    NODE_TRANSPORT: base.transport,
    NODE_ENDPOINT: base.endpoint,
    NODE_TENANT_ID: tenantIds.length === 1 ? tenantIds[0] : "",
    NODE_TENANT_IDS: tenantIds.join(","),
    NODE_TASK_TYPES: taskTypes.join(","),
    NODE_MODELS: modelRefs.join(","),
    NODE_MAX_CONCURRENT: String(base.maxConcurrent),
    NODE_RESOURCES_CPU: String((base.resources as any).cpu ?? 0),
    NODE_RESOURCES_GPU: String((base.resources as any).gpu ?? 0),
    NODE_RESOURCES_VRAM_MB: String((base.resources as any).vramMb ?? 0),
    NODE_HEARTBEAT_INTERVAL_MS: "10000",
    NODE_CONTRACT_VERSION: "contractVersion" in base ? (base as any).contractVersion : "1.0",
    NODE_AUTH_ADMIN_SECRET: "${NODE_AUTH_ADMIN_SECRET}"
  };
  const warnings: string[] = [];
  if (taskTypes.length === 0) warnings.push("Node does not declare any taskTypes");
  if (modelRefs.length === 0) warnings.push("Node does not declare any models");
  if (runtime === "yolo" && taskTypes.includes("face_detection") && !modelRefs.some((m) => m.includes("face")))
    warnings.push("Face detection is declared but no face-specific modelRef was found");
  return {
    nodeId: args.nodeId,
    source,
    runtime,
    serviceName,
    deploymentContractVersion: "1.0",
    imageHint:
      runtime === "mediapipe" ? "nearhome/inference-node-mediapipe:local" : "nearhome/inference-node-yolo:local",
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

function yamlScalar(value: unknown) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

function renderYaml(value: unknown, indent = 0): string {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${prefix}[]`;
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          const nested = renderYaml(item, indent + 2);
          const [firstLine, ...rest] = nested.split("\n");
          return `${prefix}- ${firstLine.trimStart()}${rest.length ? `\n${rest.join("\n")}` : ""}`;
        }
        return `${prefix}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${prefix}{}`;
    return entries
      .map(([key, item]) => {
        if (item && typeof item === "object") return `${prefix}${key}:\n${renderYaml(item, indent + 2)}`;
        return `${prefix}${key}: ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  return `${prefix}${yamlScalar(value)}`;
}

function buildDeployBundle(definitions: Array<ReturnType<typeof buildNodeDeployDefinition>>) {
  const effective = definitions.filter((d): d is NonNullable<typeof d> => Boolean(d));
  const services: Record<string, unknown> = {};
  for (const def of effective) Object.assign(services, def.composeService);
  const composeYaml = ["services:", renderYaml(services, 2), ""].join("\n");
  return {
    generatedAt: new Date().toISOString(),
    nodeIds: effective.map((d) => d.nodeId),
    warnings: effective.flatMap((d) => d.warnings.map((w) => ({ nodeId: d.nodeId, message: w }))),
    composeYaml,
    definitions: effective
  };
}

async function persistDeployBundle(args: { bundle: ReturnType<typeof buildDeployBundle>; outputPath: string }) {
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

async function probeService(name: string, targetUrl: string) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(targetUrl, { signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = await response.json();
      payload = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }
    return {
      name,
      url: targetUrl,
      ok: response.ok,
      statusCode: response.status,
      latencyMs,
      error: response.ok ? null : `http_${response.status}`,
      payload
    };
  } catch (error) {
    return {
      name,
      url: targetUrl,
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      payload: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBridgeNode(nodeRaw: Record<string, unknown>) {
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
  const status =
    statusValue === "online" || statusValue === "degraded"
      ? (statusValue as "online" | "degraded")
      : ("offline" as const);
  const resourcesRaw =
    nodeRaw.resources && typeof nodeRaw.resources === "object"
      ? (nodeRaw.resources as Record<string, unknown>)
      : { cpu: 0, gpu: 0, vramMb: 0 };
  const resources = Object.fromEntries(
    Object.entries(resourcesRaw).map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : 0])
  );
  const capabilitiesRaw = Array.isArray(nodeRaw.capabilities) ? nodeRaw.capabilities : [];
  const capabilities = capabilitiesRaw.map((item: any, index: number) => {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      capabilityId:
        typeof entry.capabilityId === "string" && entry.capabilityId.length > 0 ? entry.capabilityId : `cap-${index}`,
      taskTypes: Array.isArray(entry.taskTypes)
        ? entry.taskTypes.filter((x): x is string => typeof x === "string")
        : [],
      models: Array.isArray(entry.models) ? entry.models.filter((x): x is string => typeof x === "string") : []
    };
  });
  const models = Array.isArray(nodeRaw.models) ? nodeRaw.models.filter((x): x is string => typeof x === "string") : [];
  const maxConcurrent = Number.isFinite(Number(nodeRaw.maxConcurrent)) ? Math.max(1, Number(nodeRaw.maxConcurrent)) : 1;
  const queueDepth = Number.isFinite(Number(nodeRaw.queueDepth)) ? Math.max(0, Number(nodeRaw.queueDepth)) : 0;
  const isDrained = nodeRaw.isDrained === true;
  const parsedHeartbeat =
    typeof nodeRaw.lastHeartbeatAt === "string" ? Date.parse(nodeRaw.lastHeartbeatAt) : Date.now();
  const lastHeartbeatAt = Number.isFinite(parsedHeartbeat) ? new Date(parsedHeartbeat) : new Date();
  const contractVersion = typeof nodeRaw.contractVersion === "string" ? nodeRaw.contractVersion : "1.0";
  return {
    nodeId,
    tenantId,
    tenantIds,
    runtime,
    transport,
    endpoint,
    status,
    resources,
    capabilities,
    models,
    maxConcurrent,
    queueDepth,
    isDrained,
    lastHeartbeatAt,
    contractVersion
  };
}

async function syncInferenceNodeSnapshots(nodesRaw: Array<Record<string, unknown>>) {
  const normalized = nodesRaw
    .map(normalizeBridgeNode)
    .filter((item): item is NonNullable<ReturnType<typeof normalizeBridgeNode>> => Boolean(item));
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
    const existing = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId: node.nodeId },
      include: { assignments: { select: { tenantId: true } } }
    });
    const existingTenantIds = existing ? existing.assignments.map((a) => a.tenantId) : [];
    const effectiveTenantIds = bridgeTenantIds.length > 0 ? bridgeTenantIds : existingTenantIds;
    const tenantId = effectiveTenantIds.length === 1 ? effectiveTenantIds[0] : null;
    await prisma.inferenceNodeSnapshot.upsert({
      where: { nodeId: node.nodeId },
      update: {
        tenantId,
        runtime: node.runtime,
        transport: node.transport,
        endpoint: node.endpoint,
        status: node.status,
        resources: JSON.stringify(node.resources),
        capabilities: JSON.stringify(node.capabilities),
        models: JSON.stringify(node.models),
        maxConcurrent: node.maxConcurrent,
        queueDepth: node.queueDepth,
        isDrained: node.isDrained,
        lastHeartbeatAt: node.lastHeartbeatAt,
        contractVersion: node.contractVersion
      },
      create: {
        nodeId: node.nodeId,
        tenantId,
        runtime: node.runtime,
        transport: node.transport,
        endpoint: node.endpoint,
        status: node.status,
        resources: JSON.stringify(node.resources),
        capabilities: JSON.stringify(node.capabilities),
        models: JSON.stringify(node.models),
        maxConcurrent: node.maxConcurrent,
        queueDepth: node.queueDepth,
        isDrained: node.isDrained,
        lastHeartbeatAt: node.lastHeartbeatAt,
        contractVersion: node.contractVersion
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

// ─── Plugin ───────────────────────────────────────────────────────────────────

export const opsPlugin: FastifyPluginAsync<OpsPluginOptions> = async (app, opts) => {
  const { authPreHandler } = opts.middleware;
  const {
    inferenceBridgeUrl,
    nodeAuthAdminSecret,
    streamGatewayUrl,
    eventGatewayUrl,
    temporalDispatchUrl,
    detectionDeployOutputPath,
    repoRoot
  } = opts;

  const detectionStackSyncTimeoutMs = opts.detectionStackSyncTimeoutMs ?? 120_000;
  const detectionStackSyncMaxRetries = opts.detectionStackSyncMaxRetries ?? 0;
  const detectionStackSyncRetryDelayMs = opts.detectionStackSyncRetryDelayMs ?? 5_000;
  const detectionStackSyncCommand = opts.detectionStackSyncCommand ?? null;

  const appendDetectionStackSyncLog = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    detectionStackSyncState = {
      ...detectionStackSyncState,
      logTail: [...detectionStackSyncState.logTail, trimmed].slice(-80)
    };
  };

  const runDetectionStackSync = (args: {
    mode: "onprem" | "onprem-remote";
    profile?: string | null;
    dryRun?: boolean;
    timeoutMs?: number;
    maxRetries?: number;
    retryDelayMs?: number;
  }) => {
    const timeoutMs = args.timeoutMs ?? detectionStackSyncTimeoutMs;
    const maxRetries = args.maxRetries ?? detectionStackSyncMaxRetries;
    const retryDelayMs = args.retryDelayMs ?? detectionStackSyncRetryDelayMs;
    const maxAttempts = maxRetries + 1;
    const commandSuffix = `${args.mode}${args.profile ? ` ${args.profile}` : ""}`;
    const command = detectionStackSyncCommand
      ? `${detectionStackSyncCommand} ${commandSuffix}`.trim()
      : `bash scripts/pilot/stack-sync-detection.sh ${commandSuffix}`;
    const startedAt = new Date().toISOString();
    detectionStackSyncState = {
      status: args.dryRun ? "succeeded" : "running",
      mode: args.mode,
      profile: args.profile ?? null,
      attempt: 1,
      maxAttempts,
      timeoutMs,
      retryDelayMs,
      startedAt,
      finishedAt: args.dryRun ? startedAt : null,
      exitCode: args.dryRun ? 0 : null,
      command,
      logTail: args.dryRun
        ? [`dry-run ${command}`, `config timeout=${timeoutMs}ms attempts=${maxAttempts} retryDelay=${retryDelayMs}ms`]
        : [`started ${command}`, `config timeout=${timeoutMs}ms attempts=${maxAttempts} retryDelay=${retryDelayMs}ms`],
      errorMessage: null
    };
    if (args.dryRun) return;
    const runId = ++detectionStackSyncRunId;
    const executeAttempt = (attempt: number) => {
      if (runId !== detectionStackSyncRunId) return;
      detectionStackSyncState = {
        ...detectionStackSyncState,
        status: "running",
        attempt,
        finishedAt: null,
        exitCode: null,
        errorMessage: null
      };
      appendDetectionStackSyncLog(`attempt ${attempt}/${maxAttempts}`);
      const child = spawn(command, { cwd: repoRoot, env: process.env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let settled = false;
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        appendDetectionStackSyncLog(`timeout ${timeoutMs}ms; sending SIGTERM`);
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            appendDetectionStackSyncLog("forcing SIGKILL");
            child.kill("SIGKILL");
          }
        }, 5_000).unref();
      }, timeoutMs);
      const scheduleRetryOrFail = (message: string, exitCode: number) => {
        if (settled || runId !== detectionStackSyncRunId) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (attempt < maxAttempts) {
          const nextAttempt = attempt + 1;
          appendDetectionStackSyncLog(`attempt ${attempt} failed: ${message}`);
          appendDetectionStackSyncLog(`retrying in ${retryDelayMs}ms (${nextAttempt}/${maxAttempts})`);
          setTimeout(() => executeAttempt(nextAttempt), retryDelayMs).unref();
          return;
        }
        detectionStackSyncState = {
          ...detectionStackSyncState,
          status: "failed",
          finishedAt: new Date().toISOString(),
          exitCode,
          errorMessage: message
        };
        appendDetectionStackSyncLog(`finished exit=${exitCode}`);
      };
      child.stdout.on("data", (chunk) => {
        if (runId !== detectionStackSyncRunId) return;
        appendDetectionStackSyncLog(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        if (runId !== detectionStackSyncRunId) return;
        appendDetectionStackSyncLog(String(chunk));
      });
      child.on("error", (error) => {
        app.log.error({ error }, "ops.nodes.stack_sync_failed");
        scheduleRetryOrFail(error.message, -1);
      });
      child.on("close", (code, signal) => {
        if (settled || runId !== detectionStackSyncRunId) return;
        clearTimeout(timeoutHandle);
        if (!timedOut && code === 0) {
          settled = true;
          detectionStackSyncState = {
            ...detectionStackSyncState,
            status: "succeeded",
            finishedAt: new Date().toISOString(),
            exitCode: 0,
            errorMessage: null
          };
          appendDetectionStackSyncLog("finished exit=0");
          return;
        }
        const failureMessage = timedOut
          ? `Stack sync timed out after ${timeoutMs}ms`
          : `Stack sync exited with code ${code ?? -1}${signal ? ` (signal ${signal})` : ""}`;
        scheduleRetryOrFail(failureMessage, code ?? -1);
      });
    };
    executeAttempt(1);
  };

  const syncNodeTenantsInBridge = async (nodeId: string, tenantIds: string[]) => {
    const response = await fetch(`${inferenceBridgeUrl}/v1/nodes/${encodeURIComponent(nodeId)}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-node-auth-admin-secret": nodeAuthAdminSecret },
      body: JSON.stringify({ tenantIds })
    });
    const raw = await response.text();
    if (response.status === 404) {
      app.log.warn({ nodeId, tenantIds }, "ops.nodes.bridge_node_not_registered_for_tenant_assignment");
      return;
    }
    if (!response.ok)
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_TENANT_ASSIGNMENT_BRIDGE_FAILED",
        message: "Failed syncing node tenant assignment in inference bridge",
        details: { statusCode: response.status, body: raw, nodeId, tenantIds }
      });
  };

  const hasGlobalSuperuserPrivileges = (request: FastifyRequest) =>
    Boolean(request.ctx?.isSuperuser && !request.ctx?.isImpersonating);

  // ─── Routes ─────────────────────────────────────────────────────────────────

  app.get("/ops/deployment/status", { preHandler: authPreHandler }, async (_request: FastifyRequest) => {
    const checks = [];
    if (streamGatewayUrl) checks.push(probeService("stream-gateway", `${streamGatewayUrl}/health`));
    if (eventGatewayUrl) checks.push(probeService("event-gateway", `${eventGatewayUrl}/health`));
    checks.push(probeService("inference-bridge", `${inferenceBridgeUrl}/health`));
    checks.push(probeService("detector", `http://detector:8000/health`));
    checks.push(probeService("inference-node-yolo", `http://inference-node-yolo:8091/health`));
    checks.push(probeService("inference-node-mediapipe", `http://inference-node-mediapipe:8092/health`));
    checks.push(probeService("mediamtx", `http://rtsp-sim:8888/hls/`));
    if (temporalDispatchUrl) checks.push(probeService("detection-dispatcher", `${temporalDispatchUrl}/health`));
    const services = await Promise.all(checks);
    const nodesProbe = await probeService("inference-bridge-nodes", `${inferenceBridgeUrl}/v1/nodes`);
    const nodesRaw = Array.isArray(nodesProbe.payload?.data)
      ? (nodesProbe.payload?.data as Array<Record<string, unknown>>)
      : [];
    if (nodesProbe.ok && nodesRaw.length > 0) {
      try {
        await syncInferenceNodeSnapshots(nodesRaw);
      } catch (error) {
        app.log.warn({ error }, "ops.nodes.sync_failed");
      }
    }
    const totalNodes = nodesRaw.length;
    const online = nodesRaw.filter((n) => n.status === "online").length;
    const degraded = nodesRaw.filter((n) => n.status === "degraded").length;
    const offline = nodesRaw.filter((n) => n.status === "offline").length;
    const drained = nodesRaw.filter((n) => n.isDrained === true).length;
    const inferredRevoked = nodesRaw.filter((n) => n.isDrained === true && n.status === "offline").length;
    return {
      data: {
        generatedAt: new Date().toISOString(),
        overallOk: services.every((s) => s.ok) && nodesProbe.ok,
        services,
        nodes: {
          sourceOk: nodesProbe.ok,
          sourceError: nodesProbe.error,
          total: totalNodes,
          online,
          degraded,
          offline,
          drained,
          revokedEstimate: inferredRevoked,
          items: nodesRaw
        }
      }
    };
  });

  // ─── Model catalog ────────────────────────────────────────────────────────

  app.get(
    "/ops/model-catalog",
    { preHandler: authPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, unknown>;
      const where = {
        ...(typeof query.provider === "string" ? { provider: query.provider } : {}),
        ...(typeof query.taskType === "string" ? { taskType: query.taskType } : {}),
        ...(typeof query.quality === "string" ? { quality: query.quality } : {}),
        ...(typeof query.status === "string" ? { status: query.status } : {})
      };
      const rows = await prisma.modelCatalogEntry.findMany({
        where,
        orderBy: [{ provider: "asc" }, { taskType: "asc" }, { quality: "asc" }, { displayName: "asc" }]
      });
      reply.header("x-total-count", String(rows.length));
      return { data: rows.map(modelCatalogEntryResponse), total: rows.length };
    }
  );

  app.post("/ops/model-catalog", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!request.ctx?.isSuperuser) throw app.httpErrors.forbidden("Only superuser can create catalog entries");
    const body = ModelCatalogEntryInputSchema.parse(request.body ?? {});
    const row = await prisma.modelCatalogEntry.create({
      data: {
        provider: body.provider,
        taskType: body.taskType,
        quality: body.quality,
        modelRef: body.modelRef,
        displayName: body.displayName,
        resources: JSON.stringify(body.resources),
        defaults: body.defaults ? JSON.stringify(body.defaults) : null,
        outputs: body.outputs ? JSON.stringify(body.outputs) : null,
        status: body.status
      }
    });
    return { data: modelCatalogEntryResponse(row) };
  });

  app.put("/ops/model-catalog/:id", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!request.ctx?.isSuperuser) throw app.httpErrors.forbidden("Only superuser can update catalog entries");
    const { id } = request.params as { id: string };
    const body = ModelCatalogEntryInputSchema.partial().parse(request.body ?? {});
    const row = await prisma.modelCatalogEntry.update({
      where: { id },
      data: {
        ...(body.provider !== undefined ? { provider: body.provider } : {}),
        ...(body.taskType !== undefined ? { taskType: body.taskType } : {}),
        ...(body.quality !== undefined ? { quality: body.quality } : {}),
        ...(body.modelRef !== undefined ? { modelRef: body.modelRef } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.resources !== undefined ? { resources: JSON.stringify(body.resources) } : {}),
        ...(body.defaults !== undefined ? { defaults: body.defaults ? JSON.stringify(body.defaults) : null } : {}),
        ...(body.outputs !== undefined ? { outputs: body.outputs ? JSON.stringify(body.outputs) : null } : {}),
        ...(body.status !== undefined ? { status: body.status } : {})
      }
    });
    return { data: modelCatalogEntryResponse(row) };
  });

  // ─── Nodes ────────────────────────────────────────────────────────────────

  app.get("/ops/nodes", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const q = request.query as { sync?: string };
    if (q.sync !== "0") {
      const nodesProbe = await probeService("inference-bridge-nodes", `${inferenceBridgeUrl}/v1/nodes`);
      const nodesRaw = Array.isArray(nodesProbe.payload?.data)
        ? (nodesProbe.payload?.data as Array<Record<string, unknown>>)
        : [];
      if (nodesProbe.ok && nodesRaw.length > 0) {
        try {
          await syncInferenceNodeSnapshots(nodesRaw);
        } catch (error) {
          app.log.warn({ error }, "ops.nodes.sync_failed");
        }
      }
    }
    const rows = await prisma.inferenceNodeSnapshot.findMany({
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } },
      orderBy: { updatedAt: "desc" }
    });
    return { data: rows.map(snapshotResponse), total: rows.length };
  });

  app.get("/ops/nodes/:nodeId", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    if (!row) throw app.httpErrors.notFound("Node not found");
    return { data: snapshotResponse(row) };
  });

  app.get("/ops/nodes/:nodeId/config", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const [desiredRow, observedRow] = await Promise.all([
      prisma.inferenceNodeDesiredConfig.findUnique({ where: { nodeId } }),
      prisma.inferenceNodeSnapshot.findUnique({
        where: { nodeId },
        include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
      })
    ]);
    if (!desiredRow && !observedRow) throw app.httpErrors.notFound("Node not found");
    const desired = desiredRow ? normalizeDesiredNodeConfig(desiredRow) : null;
    const observed = observedRow ? nodeObservedConfigResponse(observedRow) : null;
    const diff = buildNodeConfigDiff({
      desired,
      observed: observed
        ? {
            runtime: observed.runtime,
            transport: observed.transport,
            endpoint: observed.endpoint,
            resources: observed.resources,
            capabilities: observed.capabilities,
            models: observed.models,
            assignedTenantIds: observed.assignedTenantIds,
            maxConcurrent: observed.maxConcurrent
          }
        : null
    });
    return { data: { nodeId, desiredConfig: desired, observedConfig: observed, diff } };
  });

  app.put("/ops/nodes/:nodeId/config", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!request.ctx?.isSuperuser) throw app.httpErrors.forbidden("Only superuser can update node config");
    const { nodeId } = request.params as { nodeId: string };
    const body = z
      .object({
        runtime: z.string().min(1),
        transport: z.enum(["http", "grpc"]).default("http"),
        endpoint: z.string().min(1),
        resources: z.record(z.number()).default({ cpu: 1, gpu: 0, vramMb: 0 }),
        capabilities: z.array(DesiredNodeCapabilitySchema).default([]),
        models: z.array(z.string()).default([]),
        tenantIds: z.array(z.string()).default([]),
        maxConcurrent: z.number().int().min(1).default(1),
        contractVersion: z.string().default("1.0"),
        markApplied: z.boolean().default(false)
      })
      .parse(request.body ?? {});
    const normalizedTenantIds = Array.from(new Set(body.tenantIds.map((id) => id.trim()).filter(Boolean)));
    if (normalizedTenantIds.length > 0) {
      const existingTenants = await prisma.tenant.findMany({
        where: { id: { in: normalizedTenantIds }, deletedAt: null },
        select: { id: true }
      });
      const existingIds = new Set(existingTenants.map((t) => t.id));
      const invalid = normalizedTenantIds.filter((id) => !existingIds.has(id));
      if (invalid.length > 0) throw app.httpErrors.badRequest(`Invalid tenant ids: ${invalid.join(", ")}`);
    }
    await prisma.inferenceNodeSnapshot.upsert({
      where: { nodeId },
      update: {
        tenantId: normalizedTenantIds.length === 1 ? normalizedTenantIds[0] : null,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        status: "offline",
        resources: JSON.stringify(body.resources),
        capabilities: JSON.stringify(body.capabilities),
        models: JSON.stringify(body.models),
        maxConcurrent: body.maxConcurrent,
        queueDepth: 0,
        isDrained: false,
        lastHeartbeatAt: new Date(),
        contractVersion: body.contractVersion
      },
      create: {
        nodeId,
        tenantId: normalizedTenantIds.length === 1 ? normalizedTenantIds[0] : null,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        status: "offline",
        resources: JSON.stringify(body.resources),
        capabilities: JSON.stringify(body.capabilities),
        models: JSON.stringify(body.models),
        maxConcurrent: body.maxConcurrent,
        queueDepth: 0,
        isDrained: false,
        lastHeartbeatAt: new Date(),
        contractVersion: body.contractVersion
      }
    });
    await prisma.inferenceNodeTenantAssignment.deleteMany({ where: { nodeId } });
    if (normalizedTenantIds.length > 0)
      await prisma.inferenceNodeTenantAssignment.createMany({
        data: normalizedTenantIds.map((tid) => ({ nodeId, tenantId: tid }))
      });
    const existing = await prisma.inferenceNodeDesiredConfig.findUnique({ where: { nodeId } });
    const row = await prisma.inferenceNodeDesiredConfig.upsert({
      where: { nodeId },
      update: {
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        desiredResources: JSON.stringify(body.resources),
        desiredCapabilities: JSON.stringify(body.capabilities),
        desiredModels: JSON.stringify(body.models),
        desiredTenantIds: JSON.stringify(normalizedTenantIds),
        maxConcurrent: body.maxConcurrent,
        contractVersion: body.contractVersion,
        configVersion: existing ? existing.configVersion + 1 : 1,
        ...(body.markApplied ? { lastAppliedAt: new Date() } : {})
      },
      create: {
        nodeId,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        desiredResources: JSON.stringify(body.resources),
        desiredCapabilities: JSON.stringify(body.capabilities),
        desiredModels: JSON.stringify(body.models),
        desiredTenantIds: JSON.stringify(normalizedTenantIds),
        maxConcurrent: body.maxConcurrent,
        contractVersion: body.contractVersion,
        configVersion: 1,
        ...(body.markApplied ? { lastAppliedAt: new Date() } : {})
      }
    });
    return { data: normalizeDesiredNodeConfig(row) };
  });

  app.post("/ops/nodes/:nodeId/config/apply", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!request.ctx?.isSuperuser) throw app.httpErrors.forbidden("Only superuser can apply node config");
    const { nodeId } = request.params as { nodeId: string };
    const body = z.object({ syncBridgeTenantAssignments: z.boolean().default(false) }).parse(request.body ?? {});
    const desiredRow = await prisma.inferenceNodeDesiredConfig.findUnique({ where: { nodeId } });
    if (!desiredRow) throw app.httpErrors.notFound("Node desired config not found");
    const desiredConfig = normalizeDesiredNodeConfig(desiredRow);
    if (body.syncBridgeTenantAssignments) await syncNodeTenantsInBridge(nodeId, desiredConfig.tenantIds);
    const appliedAt = new Date();
    const updatedRow = await prisma.inferenceNodeDesiredConfig.update({
      where: { nodeId },
      data: { lastAppliedAt: appliedAt }
    });
    const observedRow = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    const observed = observedRow ? nodeObservedConfigResponse(observedRow) : null;
    const desired = normalizeDesiredNodeConfig(updatedRow);
    const diff = buildNodeConfigDiff({
      desired,
      observed: observed
        ? {
            runtime: observed.runtime,
            transport: observed.transport,
            endpoint: observed.endpoint,
            resources: observed.resources,
            capabilities: observed.capabilities,
            models: observed.models,
            assignedTenantIds: observed.assignedTenantIds,
            maxConcurrent: observed.maxConcurrent
          }
        : null
    });
    return {
      data: {
        nodeId,
        desiredConfig: desired,
        observedConfig: observed,
        diff,
        appliedAt: appliedAt.toISOString(),
        syncedBridgeTenantAssignments: body.syncBridgeTenantAssignments
      }
    };
  });

  app.get("/ops/nodes/:nodeId/deploy-definition", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const [desiredRow, observedRow] = await Promise.all([
      prisma.inferenceNodeDesiredConfig.findUnique({ where: { nodeId } }),
      prisma.inferenceNodeSnapshot.findUnique({
        where: { nodeId },
        include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
      })
    ]);
    if (!desiredRow && !observedRow) throw app.httpErrors.notFound("Node not found");
    const desired = desiredRow ? normalizeDesiredNodeConfig(desiredRow) : null;
    const observed = observedRow ? nodeObservedConfigResponse(observedRow) : null;
    const definition = buildNodeDeployDefinition({ nodeId, desired, observed });
    if (!definition) throw app.httpErrors.notFound("Node not found");
    return { data: definition };
  });

  app.get("/ops/nodes/deploy-bundle", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const query = z.object({ nodeIds: z.string().optional() }).parse(request.query ?? {});
    const requestedNodeIds = Array.from(
      new Set(
        (query.nodeIds ?? "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      )
    );
    const whereClause = requestedNodeIds.length > 0 ? { nodeId: { in: requestedNodeIds } } : {};
    const [desiredRows, observedRows] = await Promise.all([
      prisma.inferenceNodeDesiredConfig.findMany({ where: whereClause, orderBy: { nodeId: "asc" } }),
      prisma.inferenceNodeSnapshot.findMany({
        where: whereClause,
        include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } },
        orderBy: { nodeId: "asc" }
      })
    ]);
    const desiredByNodeId = new Map(desiredRows.map((r) => [r.nodeId, normalizeDesiredNodeConfig(r)]));
    const observedByNodeId = new Map(observedRows.map((r) => [r.nodeId, nodeObservedConfigResponse(r)]));
    const nodeIds =
      requestedNodeIds.length > 0
        ? requestedNodeIds
        : Array.from(new Set([...desiredByNodeId.keys(), ...observedByNodeId.keys()])).sort();
    if (nodeIds.length === 0)
      return {
        data: {
          generatedAt: new Date().toISOString(),
          nodeIds: [],
          warnings: [],
          composeYaml: "services:\n  {}\n",
          definitions: []
        }
      };
    const definitions = nodeIds
      .map((id) =>
        buildNodeDeployDefinition({
          nodeId: id,
          desired: desiredByNodeId.get(id) ?? null,
          observed: observedByNodeId.get(id) ?? null
        })
      )
      .filter((d): d is NonNullable<typeof d> => Boolean(d));
    return { data: buildDeployBundle(definitions) };
  });

  app.post("/ops/nodes/deploy-bundle/export", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!request.ctx?.isSuperuser) throw app.httpErrors.forbidden("Only superuser can export deploy bundles");
    const body = z.object({ nodeIds: z.array(z.string().min(1)).optional() }).parse(request.body ?? {});
    const requestedNodeIds = Array.from(new Set((body.nodeIds ?? []).map((v) => v.trim()).filter(Boolean)));
    const whereClause = requestedNodeIds.length > 0 ? { nodeId: { in: requestedNodeIds } } : {};
    const [desiredRows, observedRows] = await Promise.all([
      prisma.inferenceNodeDesiredConfig.findMany({ where: whereClause, orderBy: { nodeId: "asc" } }),
      prisma.inferenceNodeSnapshot.findMany({
        where: whereClause,
        include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } },
        orderBy: { nodeId: "asc" }
      })
    ]);
    const desiredByNodeId = new Map(desiredRows.map((r) => [r.nodeId, normalizeDesiredNodeConfig(r)]));
    const observedByNodeId = new Map(observedRows.map((r) => [r.nodeId, nodeObservedConfigResponse(r)]));
    const nodeIds =
      requestedNodeIds.length > 0
        ? requestedNodeIds
        : Array.from(new Set([...desiredByNodeId.keys(), ...observedByNodeId.keys()])).sort();
    const definitions = nodeIds
      .map((id) =>
        buildNodeDeployDefinition({
          nodeId: id,
          desired: desiredByNodeId.get(id) ?? null,
          observed: observedByNodeId.get(id) ?? null
        })
      )
      .filter((d): d is NonNullable<typeof d> => Boolean(d));
    const bundle = buildDeployBundle(definitions);
    const exported = await persistDeployBundle({ bundle, outputPath: detectionDeployOutputPath });
    return { data: { ...bundle, export: exported } };
  });

  app.get("/ops/nodes/stack-sync-detection", { preHandler: authPreHandler }, async () => {
    return { data: detectionStackSyncState };
  });

  app.post("/ops/nodes/stack-sync-detection", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!request.ctx?.isSuperuser) throw app.httpErrors.forbidden("Only superuser can trigger stack sync");
    const body = z
      .object({
        mode: z.enum(["onprem", "onprem-remote"]).default("onprem"),
        profile: z.string().trim().min(1).optional(),
        dryRun: z.boolean().default(false),
        timeoutMs: z.number().int().min(5_000).max(3_600_000).optional(),
        maxRetries: z.number().int().min(0).max(5).optional(),
        retryDelayMs: z.number().int().min(0).max(60_000).optional()
      })
      .parse(request.body ?? {});
    if (detectionStackSyncState.status === "running")
      throw new ApiDomainError({
        statusCode: 409,
        apiCode: "STACK_SYNC_ALREADY_RUNNING",
        message: "A detection stack sync is already running",
        details: detectionStackSyncState
      });
    runDetectionStackSync({
      mode: body.mode,
      profile: body.profile ?? null,
      dryRun: body.dryRun,
      timeoutMs: body.timeoutMs,
      maxRetries: body.maxRetries,
      retryDelayMs: body.retryDelayMs
    });
    return { data: detectionStackSyncState };
  });

  app.get("/ops/nodes/:nodeId/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    if (!row) throw app.httpErrors.notFound("Node not found");
    return { data: { nodeId: row.nodeId, tenantIds: row.assignments.map((a) => a.tenantId) } };
  });

  app.put("/ops/nodes/:nodeId/tenants", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    if (!hasGlobalSuperuserPrivileges(request))
      throw app.httpErrors.forbidden("Only superuser can assign node tenants");
    const { nodeId } = request.params as { nodeId: string };
    const body = z.object({ tenantIds: z.array(z.string().min(1)).default([]) }).parse(request.body ?? {});
    const normalizedTenantIds = Array.from(new Set(body.tenantIds.map((id) => id.trim()).filter(Boolean)));
    const node = await prisma.inferenceNodeSnapshot.findUnique({ where: { nodeId }, select: { nodeId: true } });
    if (!node) throw app.httpErrors.notFound("Node not found");
    if (normalizedTenantIds.length > 0) {
      const existingTenants = await prisma.tenant.findMany({
        where: { id: { in: normalizedTenantIds }, deletedAt: null },
        select: { id: true }
      });
      const existingIds = new Set(existingTenants.map((t) => t.id));
      const invalid = normalizedTenantIds.filter((id) => !existingIds.has(id));
      if (invalid.length > 0) throw app.httpErrors.badRequest(`Invalid tenant ids: ${invalid.join(", ")}`);
    }
    await prisma.$transaction(async (tx) => {
      await tx.inferenceNodeTenantAssignment.deleteMany({ where: { nodeId } });
      if (normalizedTenantIds.length > 0)
        await tx.inferenceNodeTenantAssignment.createMany({
          data: normalizedTenantIds.map((tid) => ({ nodeId, tenantId: tid }))
        });
      await tx.inferenceNodeSnapshot.update({
        where: { nodeId },
        data: { tenantId: normalizedTenantIds.length === 1 ? normalizedTenantIds[0] : null }
      });
    });
    await syncNodeTenantsInBridge(nodeId, normalizedTenantIds);
    const updated = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    if (!updated) throw app.httpErrors.notFound("Node not found");
    return { data: snapshotResponse(updated) };
  });

  app.post("/ops/nodes/provision", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const body = z
      .object({
        nodeId: z.string().min(3),
        tenantScope: z.string().optional(),
        runtime: z.string().default("mediapipe"),
        transport: z.enum(["http", "grpc"]).default("http"),
        endpoint: z.string().min(1),
        capabilities: z
          .array(
            z.object({
              capabilityId: z.string(),
              taskTypes: z.array(z.string()).default([]),
              models: z.array(z.string()).default([]),
              qualities: z.array(DetectionQualitySchema).default([])
            })
          )
          .default([]),
        models: z.array(z.string()).default([]),
        resources: z.record(z.number()).default({ cpu: 1, gpu: 0, vramMb: 0 }),
        maxConcurrent: z.number().int().min(1).default(1),
        contractVersion: z.string().default("1.0"),
        ttlSeconds: z.number().int().min(60).max(3600).optional()
      })
      .parse(request.body);
    const tenantId = body.tenantScope && body.tenantScope !== "*" ? body.tenantScope : null;
    if (tenantId) {
      const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null }, select: { id: true } });
      if (!tenant) throw app.httpErrors.badRequest("Invalid tenantScope");
    }
    await prisma.inferenceNodeSnapshot.upsert({
      where: { nodeId: body.nodeId },
      update: {
        tenantId,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        status: "offline",
        resources: JSON.stringify(body.resources),
        capabilities: JSON.stringify(body.capabilities),
        models: JSON.stringify(body.models),
        maxConcurrent: body.maxConcurrent,
        queueDepth: 0,
        isDrained: false,
        lastHeartbeatAt: new Date(),
        contractVersion: body.contractVersion
      },
      create: {
        nodeId: body.nodeId,
        tenantId,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        status: "offline",
        resources: JSON.stringify(body.resources),
        capabilities: JSON.stringify(body.capabilities),
        models: JSON.stringify(body.models),
        maxConcurrent: body.maxConcurrent,
        queueDepth: 0,
        isDrained: false,
        lastHeartbeatAt: new Date(),
        contractVersion: body.contractVersion
      }
    });
    const existingDesired = await prisma.inferenceNodeDesiredConfig.findUnique({ where: { nodeId: body.nodeId } });
    await prisma.inferenceNodeDesiredConfig.upsert({
      where: { nodeId: body.nodeId },
      update: {
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        desiredResources: JSON.stringify(body.resources),
        desiredCapabilities: JSON.stringify(body.capabilities),
        desiredModels: JSON.stringify(body.models),
        desiredTenantIds: JSON.stringify(tenantId ? [tenantId] : []),
        maxConcurrent: body.maxConcurrent,
        contractVersion: body.contractVersion,
        configVersion: existingDesired ? existingDesired.configVersion + 1 : 1
      },
      create: {
        nodeId: body.nodeId,
        runtime: body.runtime,
        transport: body.transport,
        endpoint: body.endpoint,
        desiredResources: JSON.stringify(body.resources),
        desiredCapabilities: JSON.stringify(body.capabilities),
        desiredModels: JSON.stringify(body.models),
        desiredTenantIds: JSON.stringify(tenantId ? [tenantId] : []),
        maxConcurrent: body.maxConcurrent,
        contractVersion: body.contractVersion,
        configVersion: 1
      }
    });
    await prisma.inferenceNodeTenantAssignment.deleteMany({ where: { nodeId: body.nodeId } });
    if (tenantId) await prisma.inferenceNodeTenantAssignment.create({ data: { nodeId: body.nodeId, tenantId } });
    const snapshot = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId: body.nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    const response = await fetch(`${inferenceBridgeUrl}/internal/nodes/enrollment-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-node-auth-admin-secret": nodeAuthAdminSecret },
      body: JSON.stringify({ nodeId: body.nodeId, tenantScope: body.tenantScope ?? "*", ttlSeconds: body.ttlSeconds })
    });
    const raw = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      payload = null;
    }
    if (!response.ok)
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_PROVISION_BRIDGE_FAILED",
        message: "Failed creating node enrollment token",
        details: { statusCode: response.status, body: payload ?? raw }
      });
    return {
      data: { snapshot: snapshot ? snapshotResponse(snapshot) : null, enrollment: (payload as any)?.data ?? payload }
    };
  });

  app.post("/ops/nodes/:nodeId/drain", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const response = await fetch(`${inferenceBridgeUrl}/v1/nodes/${encodeURIComponent(nodeId)}/drain`, {
      method: "POST",
      headers: { "x-node-auth-admin-secret": nodeAuthAdminSecret }
    });
    const raw = await response.text();
    if (!response.ok)
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_DRAIN_BRIDGE_FAILED",
        message: "Failed draining node in inference bridge",
        details: { statusCode: response.status, body: raw }
      });
    await prisma.inferenceNodeSnapshot.updateMany({ where: { nodeId }, data: { isDrained: true } });
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    return { data: row ? snapshotResponse(row) : { nodeId, isDrained: true } };
  });

  app.post("/ops/nodes/:nodeId/undrain", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const response = await fetch(`${inferenceBridgeUrl}/v1/nodes/${encodeURIComponent(nodeId)}/undrain`, {
      method: "POST",
      headers: { "x-node-auth-admin-secret": nodeAuthAdminSecret }
    });
    const raw = await response.text();
    if (!response.ok)
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_UNDRAIN_BRIDGE_FAILED",
        message: "Failed undraining node in inference bridge",
        details: { statusCode: response.status, body: raw }
      });
    await prisma.inferenceNodeSnapshot.updateMany({ where: { nodeId }, data: { isDrained: false } });
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    return { data: row ? snapshotResponse(row) : { nodeId, isDrained: false } };
  });

  app.post("/ops/nodes/:nodeId/revoke", { preHandler: authPreHandler }, async (request: FastifyRequest) => {
    const { nodeId } = request.params as { nodeId: string };
    const body = z.object({ reason: z.string().default("manual_revoke") }).parse(request.body ?? {});
    const response = await fetch(`${inferenceBridgeUrl}/v1/nodes/${encodeURIComponent(nodeId)}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-node-auth-admin-secret": nodeAuthAdminSecret },
      body: JSON.stringify({ reason: body.reason })
    });
    const raw = await response.text();
    if (!response.ok)
      throw new ApiDomainError({
        statusCode: 502,
        apiCode: "NODE_REVOKE_BRIDGE_FAILED",
        message: "Failed revoking node in inference bridge",
        details: { statusCode: response.status, body: raw }
      });
    await prisma.inferenceNodeSnapshot.updateMany({
      where: { nodeId },
      data: { status: "offline", isDrained: true, lastHeartbeatAt: new Date() }
    });
    const row = await prisma.inferenceNodeSnapshot.findUnique({
      where: { nodeId },
      include: { assignments: { select: { tenantId: true }, orderBy: { tenantId: "asc" } } }
    });
    return { data: row ? snapshotResponse(row) : { nodeId, status: "offline", isDrained: true } };
  });
};
