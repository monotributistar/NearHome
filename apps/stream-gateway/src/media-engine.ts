import { promises as fs } from "node:fs";
import path from "node:path";

export type StreamMediaInput = {
  tenantId: string;
  cameraId: string;
  rtspUrl: string;
};

export type StreamMediaScope = {
  tenantId: string;
  cameraId: string;
};

export type MediaEngine = {
  name: string;
  provisionStream(input: StreamMediaInput): Promise<void>;
  deprovisionStream(scope: StreamMediaScope): Promise<void>;
  readManifest(scope: StreamMediaScope): Promise<string>;
  readSegment(scope: StreamMediaScope): Promise<Buffer>;
};

function cameraDir(storageDir: string, tenantId: string, cameraId: string) {
  return path.join(storageDir, tenantId, cameraId);
}

export function createMockMediaEngine(storageDir: string): MediaEngine {
  const provisionStream = async (input: StreamMediaInput) => {
    const dir = cameraDir(storageDir, input.tenantId, input.cameraId);
    await fs.mkdir(dir, { recursive: true });

    const segmentPath = path.join(dir, "segment0.ts");
    const playlistPath = path.join(dir, "index.m3u8");

    const segment = Buffer.from("NEARHOME_STREAM_SEGMENT");
    await fs.writeFile(segmentPath, segment);

    const manifest = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:5",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:5.0,",
      "segment0.ts",
      "#EXT-X-ENDLIST"
    ].join("\n");
    await fs.writeFile(playlistPath, manifest, "utf8");
  };

  const readManifest = async (scope: StreamMediaScope) => {
    const playlistPath = path.join(cameraDir(storageDir, scope.tenantId, scope.cameraId), "index.m3u8");
    return fs.readFile(playlistPath, "utf8");
  };

  const readSegment = async (scope: StreamMediaScope) => {
    const segmentPath = path.join(cameraDir(storageDir, scope.tenantId, scope.cameraId), "segment0.ts");
    return fs.readFile(segmentPath);
  };

  const deprovisionStream = async (_scope: StreamMediaScope) => {
    // Mock engine keeps files on disk; stream state is enforced in memory by app layer.
  };

  return {
    name: "mock-filesystem",
    provisionStream,
    deprovisionStream,
    readManifest,
    readSegment
  };
}

export function createMediaEngineFromEnv(storageDir: string): MediaEngine {
  const engine = process.env.STREAM_MEDIA_ENGINE ?? "mock";
  if (engine === "mock") {
    return createMockMediaEngine(storageDir);
  }
  throw new Error(`Unsupported STREAM_MEDIA_ENGINE=${engine}`);
}

