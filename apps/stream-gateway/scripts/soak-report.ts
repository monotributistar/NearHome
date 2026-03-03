import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
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
  historyDir: string;
  indexPath: string;
  recordHistory: boolean;
  historyRows: number;
};

type SoakSummary = {
  runId: string;
  generatedAt: string;
  result: "PASS" | "FAIL";
  scenario: {
    tenants: number;
    camerasPerTenant: number;
    rounds: number;
    requestsPerCameraPerRound: number;
    roundDelayMs: number;
  };
  sli: {
    total: number;
    success: number;
    failure: number;
    errorRate: number;
    durationMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  slo: {
    maxErrorRate: number;
    maxP95Ms: number;
  };
  regression: {
    hasPrevious: boolean;
    previousRunId: string | null;
    errorRateDeltaPct: number | null;
    p95DeltaMs: number | null;
  };
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
  const defaultReportPath = path.resolve(process.cwd(), "docs/reports/stream-soak-latest.md");
  const defaultHistoryDir = path.resolve(process.cwd(), "docs/reports/history");
  const defaultIndexPath = path.resolve(process.cwd(), "docs/reports/stream-soak-history.md");
  const config: SoakConfig = {
    tenants: Math.max(1, Math.floor(envNumber("SOAK_TENANTS", 2))),
    camerasPerTenant: Math.max(1, Math.floor(envNumber("SOAK_CAMERAS_PER_TENANT", 3))),
    rounds: Math.max(1, Math.floor(envNumber("SOAK_ROUNDS", 12))),
    requestsPerCameraPerRound: Math.max(1, Math.floor(envNumber("SOAK_REQUESTS_PER_CAMERA_PER_ROUND", 4))),
    roundDelayMs: Math.max(0, Math.floor(envNumber("SOAK_ROUND_DELAY_MS", 50))),
    maxErrorRate: Math.max(0, envNumber("SOAK_MAX_ERROR_RATE", 0.01)),
    maxP95Ms: Math.max(1, envNumber("SOAK_MAX_P95_MS", 200)),
    tokenTtlMs: Math.max(5_000, Math.floor(envNumber("SOAK_TOKEN_TTL_MS", 60_000))),
    outputPath: process.env.SOAK_REPORT_PATH ?? defaultReportPath,
    historyDir: process.env.SOAK_HISTORY_DIR ?? defaultHistoryDir,
    indexPath: process.env.SOAK_INDEX_PATH ?? defaultIndexPath,
    recordHistory: (process.env.SOAK_RECORD_HISTORY ?? "1") !== "0",
    historyRows: Math.max(1, Math.floor(envNumber("SOAK_HISTORY_ROWS", 30)))
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

    const historySummaries: SoakSummary[] = [];
    if (config.recordHistory) {
      await mkdir(config.historyDir, { recursive: true });
      const historyFiles = await readdir(config.historyDir);
      const summaryFiles = historyFiles.filter((file) => file.endsWith(".json")).sort((a, b) => (a < b ? -1 : 1));
      for (const file of summaryFiles) {
        try {
          const raw = await readFile(path.join(config.historyDir, file), "utf8");
          historySummaries.push(JSON.parse(raw) as SoakSummary);
        } catch {
          // Ignore malformed history entries and continue.
        }
      }
    }
    const previousSummary = historySummaries.length > 0 ? historySummaries[historySummaries.length - 1] : null;

    const sloPassed = errorRate <= config.maxErrorRate && p95 <= config.maxP95Ms;
    const nowIso = new Date().toISOString();
    const runId = nowIso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const errorRateDeltaPct =
      previousSummary !== null ? Number(((errorRate - previousSummary.sli.errorRate) * 100).toFixed(3)) : null;
    const p95DeltaMs = previousSummary !== null ? p95 - previousSummary.sli.p95Ms : null;

    const summary: SoakSummary = {
      runId,
      generatedAt: nowIso,
      result: sloPassed ? "PASS" : "FAIL",
      scenario: {
        tenants: config.tenants,
        camerasPerTenant: config.camerasPerTenant,
        rounds: config.rounds,
        requestsPerCameraPerRound: config.requestsPerCameraPerRound,
        roundDelayMs: config.roundDelayMs
      },
      sli: {
        total,
        success,
        failure,
        errorRate,
        durationMs,
        avgMs: avg,
        p50Ms: p50,
        p95Ms: p95,
        p99Ms: p99
      },
      slo: {
        maxErrorRate: config.maxErrorRate,
        maxP95Ms: config.maxP95Ms
      },
      regression: {
        hasPrevious: previousSummary !== null,
        previousRunId: previousSummary?.runId ?? null,
        errorRateDeltaPct,
        p95DeltaMs
      }
    };

    const report = [
      "# Stream Gateway Soak Report",
      "",
      `- Generated at: ${nowIso}`,
      `- Run ID: ${runId}`,
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
      "## Regression vs Previous",
      "",
      previousSummary
        ? `- Previous run: ${previousSummary.runId} (${previousSummary.generatedAt})`
        : "- Previous run: none",
      previousSummary ? `- Error rate delta (pp): ${errorRateDeltaPct}` : "- Error rate delta (pp): n/a",
      previousSummary ? `- p95 delta (ms): ${p95DeltaMs}` : "- p95 delta (ms): n/a",
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
    if (config.recordHistory) {
      await mkdir(config.historyDir, { recursive: true });
      await writeFile(path.join(config.historyDir, `${runId}.md`), report, "utf8");
      await writeFile(path.join(config.historyDir, `${runId}.json`), JSON.stringify(summary, null, 2), "utf8");

      const allSummaries = [...historySummaries, summary];
      const recent = allSummaries.slice(-config.historyRows).reverse();
      const indexLines = [
        "# Stream Soak History",
        "",
        `Generated at: ${nowIso}`,
        "",
        "| Run ID | Time (UTC) | Result | Error Rate % | p95 ms | Duration ms | Delta Error pp | Delta p95 ms |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
        ...recent.map((item) => {
          const errorPct = (item.sli.errorRate * 100).toFixed(3);
          const deltaErr = item.regression.errorRateDeltaPct === null ? "n/a" : `${item.regression.errorRateDeltaPct}`;
          const deltaP95 = item.regression.p95DeltaMs === null ? "n/a" : `${item.regression.p95DeltaMs}`;
          return `| ${item.runId} | ${item.generatedAt} | ${item.result} | ${errorPct} | ${item.sli.p95Ms} | ${item.sli.durationMs} | ${deltaErr} | ${deltaP95} |`;
        }),
        ""
      ];
      await mkdir(path.dirname(config.indexPath), { recursive: true });
      await writeFile(config.indexPath, indexLines.join("\n"), "utf8");
    }

    console.log(`Soak report written to ${config.outputPath}`);
    if (config.recordHistory) {
      console.log(`Soak history entry written to ${path.join(config.historyDir, `${runId}.json`)}`);
      console.log(`Soak history index written to ${config.indexPath}`);
    }
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
