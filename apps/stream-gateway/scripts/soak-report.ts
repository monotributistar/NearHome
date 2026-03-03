import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { buildApp } from "../src/app.js";

type SoakConfig = {
  tenants: number;
  camerasPerTenant: number;
  rounds: number;
  requestsPerCameraPerRound: number;
  roundDelayMs: number;
  maxErrorRate: number;
  maxP95Ms: number;
  tokenTtlMs: number;
  outputPath: string;
};

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPlaybackToken(args: {
  secret: string;
  tenantId: string;
  cameraId: string;
  sid: string;
  expiresAt: Date;
  sub?: string;
}) {
  const payload = {
    sub: args.sub ?? "soak-user",
    tid: args.tenantId,
    cid: args.cameraId,
    sid: args.sid,
    exp: Math.floor(args.expiresAt.getTime() / 1000),
    iat: Math.floor(Date.now() / 1000),
    v: 1 as const
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", args.secret).update(payloadBase64).digest("base64url");
  return `${payloadBase64}.${signature}`;
}

async function main() {
  const config: SoakConfig = {
    tenants: Math.max(1, Math.floor(envNumber("SOAK_TENANTS", 2))),
    camerasPerTenant: Math.max(1, Math.floor(envNumber("SOAK_CAMERAS_PER_TENANT", 3))),
    rounds: Math.max(1, Math.floor(envNumber("SOAK_ROUNDS", 12))),
    requestsPerCameraPerRound: Math.max(1, Math.floor(envNumber("SOAK_REQUESTS_PER_CAMERA_PER_ROUND", 4))),
    roundDelayMs: Math.max(0, Math.floor(envNumber("SOAK_ROUND_DELAY_MS", 50))),
    maxErrorRate: Math.max(0, envNumber("SOAK_MAX_ERROR_RATE", 0.01)),
    maxP95Ms: Math.max(1, envNumber("SOAK_MAX_P95_MS", 200)),
    tokenTtlMs: Math.max(5_000, Math.floor(envNumber("SOAK_TOKEN_TTL_MS", 60_000))),
    outputPath: process.env.SOAK_REPORT_PATH ?? path.resolve(process.cwd(), "docs/reports/stream-soak-latest.md")
  };

  const storageDir = await mkdtemp(path.join(tmpdir(), "nearhome-stream-soak-"));
  const tokenSecret = process.env.STREAM_TOKEN_SECRET ?? "soak-stream-secret";
  process.env.STREAM_STORAGE_DIR = storageDir;
  process.env.STREAM_TOKEN_SECRET = tokenSecret;

  const app = await buildApp();
  const scopedCameras: Array<{ tenantId: string; cameraId: string }> = [];

  try {
    for (let t = 0; t < config.tenants; t += 1) {
      const tenantId = `tenant-soak-${t + 1}`;
      for (let c = 0; c < config.camerasPerTenant; c += 1) {
        const cameraId = `camera-soak-${c + 1}`;
        scopedCameras.push({ tenantId, cameraId });
        const provision = await app.inject({
          method: "POST",
          url: "/provision",
          payload: {
            tenantId,
            cameraId,
            rtspUrl: `rtsp://demo/${tenantId}/${cameraId}`
          }
        });
        if (provision.statusCode !== 200) {
          throw new Error(`Failed provisioning ${tenantId}/${cameraId}: HTTP ${provision.statusCode}`);
        }
      }
    }

    const latencies: number[] = [];
    let total = 0;
    let success = 0;
    let failure = 0;
    const startedAt = Date.now();
    let sidCounter = 0;

    for (let round = 0; round < config.rounds; round += 1) {
      const requests: Array<Promise<{ statusCode: number; latencyMs: number }>> = [];
      for (const scoped of scopedCameras) {
        for (let i = 0; i < config.requestsPerCameraPerRound; i += 1) {
          sidCounter += 1;
          const token = createPlaybackToken({
            secret: tokenSecret,
            tenantId: scoped.tenantId,
            cameraId: scoped.cameraId,
            sid: `sid-soak-${sidCounter}`,
            expiresAt: new Date(Date.now() + config.tokenTtlMs)
          });
          requests.push(
            (async () => {
              const t0 = Date.now();
              const res = await app.inject({
                method: "GET",
                url: `/playback/${scoped.tenantId}/${scoped.cameraId}/index.m3u8?token=${encodeURIComponent(token)}`
              });
              return { statusCode: res.statusCode, latencyMs: Date.now() - t0 };
            })()
          );
        }
      }

      const roundResults = await Promise.all(requests);
      for (const result of roundResults) {
        total += 1;
        latencies.push(result.latencyMs);
        if (result.statusCode === 200) success += 1;
        else failure += 1;
      }
      if (config.roundDelayMs > 0 && round < config.rounds - 1) {
        await sleep(config.roundDelayMs);
      }
    }

    const durationMs = Date.now() - startedAt;
    const errorRate = total === 0 ? 0 : failure / total;
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);
    const avg = latencies.length === 0 ? 0 : Math.round(latencies.reduce((acc, value) => acc + value, 0) / latencies.length);

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    const metricsBody = metrics.statusCode === 200 ? metrics.body : "metrics_unavailable";

    const sloPassed = errorRate <= config.maxErrorRate && p95 <= config.maxP95Ms;
    const nowIso = new Date().toISOString();

    const report = [
      "# Stream Gateway Soak Report",
      "",
      `- Generated at: ${nowIso}`,
      `- Result: ${sloPassed ? "PASS" : "FAIL"}`,
      "",
      "## Scenario",
      "",
      `- Tenants: ${config.tenants}`,
      `- Cameras per tenant: ${config.camerasPerTenant}`,
      `- Rounds: ${config.rounds}`,
      `- Requests per camera per round: ${config.requestsPerCameraPerRound}`,
      `- Round delay (ms): ${config.roundDelayMs}`,
      "",
      "## SLI Summary",
      "",
      `- Total requests: ${total}`,
      `- Success: ${success}`,
      `- Failure: ${failure}`,
      `- Error rate: ${(errorRate * 100).toFixed(3)}%`,
      `- Duration: ${durationMs}ms`,
      `- Latency avg/p50/p95/p99 (ms): ${avg}/${p50}/${p95}/${p99}`,
      "",
      "## SLO Targets",
      "",
      `- Max error rate: ${(config.maxErrorRate * 100).toFixed(3)}%`,
      `- Max p95 latency: ${config.maxP95Ms}ms`,
      "",
      "## Metrics Snapshot",
      "",
      "```text",
      metricsBody,
      "```",
      ""
    ].join("\n");

    await mkdir(path.dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, report, "utf8");

    console.log(`Soak report written to ${config.outputPath}`);
    console.log(`Result=${sloPassed ? "PASS" : "FAIL"} total=${total} errorRate=${(errorRate * 100).toFixed(3)}% p95=${p95}ms`);
    if (!sloPassed) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
