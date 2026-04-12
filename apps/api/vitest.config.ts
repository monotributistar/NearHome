import { defineConfig } from "vitest/config";
import path from "path";

const dbPath = path.resolve(__dirname, "prisma/dev.db");

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      DATABASE_URL: `file:${dbPath}`,
      JWT_SECRET: "test-jwt-secret",
      STREAM_TOKEN_SECRET: "test-stream-token-secret",
      STREAM_GATEWAY_URL: "http://localhost:3010",
      DETECTION_BRIDGE_URL: "http://localhost:8090",
      DETECTION_EXECUTION_MODE: "inline",
      DETECTION_TEMPORAL_DISPATCH_URL: "http://localhost:8072",
      DETECTION_CALLBACK_SECRET: "test-detection-callback-secret",
      EVENT_GATEWAY_URL: "http://localhost:3011",
      EVENT_PUBLISH_SECRET: "test-event-publish-secret",
      STREAM_HEALTH_SYNC_ENABLED: "0",
      LOGIN_RATE_LIMIT_MAX: "20",
      LOGIN_RATE_LIMIT_WINDOW_MS: "60000"
    }
  }
});
