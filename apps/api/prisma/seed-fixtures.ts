export const seedFixtures = {
  tenants: {
    acme: "Acme Retail",
    beta: "Beta Logistics",
    gamma: "Gamma Clinics",
    detectionJobs: "Seed NH-DP20",
    detectionValidation: "Seed NH-DP21 Validation",
    detectionTopology: "Seed NH-DP21 Topology",
    faces: "Seed Faces",
    adminBrowser: "Seed Admin Browser",
    portalBrowser: "Seed Portal Browser",
    portalScopeA: "Seed Portal Scope A",
    portalScopeB: "Seed Portal Scope B"
  },
  cameras: {
    detectionJobs: {
      name: "Seed NH-DP20 Cam",
      rtspUrl: "rtsp://demo/seed-nhdp20"
    },
    detectionValidation: {
      name: "Seed NH-DP21 Validation Cam",
      rtspUrl: "rtsp://demo/seed-nhdp21-validation"
    },
    detectionTopology: {
      name: "Seed NH-DP21 Topology Cam",
      rtspUrl: "rtsp://demo/seed-nhdp21-topology"
    },
    faces: {
      name: "Seed Faces Cam",
      rtspUrl: "rtsp://demo/seed-faces"
    },
    adminBrowserReady: {
      name: "Seed Admin Ready Cam",
      rtspUrl: "rtsp://demo/seed-admin-ready"
    },
    adminBrowserAttention: {
      name: "Seed Admin Attention Cam",
      rtspUrl: "rtsp://demo/seed-admin-attention"
    },
    adminBrowserIdle: {
      name: "Seed Admin Idle Cam",
      rtspUrl: "rtsp://demo/seed-admin-idle"
    },
    portalBrowserReady: {
      name: "Seed Portal Ready Cam",
      rtspUrl: "rtsp://demo/seed-portal-ready"
    },
    portalBrowserEntry: {
      name: "Seed Portal Entry Cam",
      rtspUrl: "rtsp://demo/seed-portal-entry"
    },
    portalScopeA: {
      name: "Seed Portal Scope Cam A",
      rtspUrl: "rtsp://demo/seed-portal-scope-a"
    },
    portalScopeB: {
      name: "Seed Portal Scope Cam B",
      rtspUrl: "rtsp://demo/seed-portal-scope-b"
    }
  },
  modelCatalog: {
    detectionJobsFace: {
      provider: "yolo",
      taskType: "face_detection",
      quality: "balanced",
      modelRef: "seed-yolo26-face-balanced",
      displayName: "Seed YOLO Face Balanced",
      resources: { cpu: 2, gpu: 0, vramMb: 0 },
      defaults: { minConfidence: 0.55, nmsIoU: 0.45 },
      outputs: { bbox: true, crop: true },
      status: "active"
    },
    detectionValidationFace: {
      provider: "yolo",
      taskType: "face_detection",
      quality: "balanced",
      modelRef: "seed-yolo26-face-balanced",
      displayName: "Seed YOLO Face Balanced",
      resources: { cpu: 2, gpu: 0, vramMb: 0 },
      defaults: { minConfidence: 0.55, nmsIoU: 0.45 },
      outputs: { bbox: true, crop: true },
      status: "active"
    },
    detectionTopologyPeople: {
      provider: "yolo",
      taskType: "person_detection",
      quality: "balanced",
      modelRef: "seed-yolo26-person-balanced",
      displayName: "Seed YOLO Person Balanced",
      resources: { cpu: 2, gpu: 0, vramMb: 0 },
      defaults: {},
      outputs: {},
      status: "active"
    },
    adminBrowserPose: {
      provider: "mediapipe",
      taskType: "pose_estimation",
      quality: "balanced",
      modelRef: "seed-mediapipe-pose-balanced",
      displayName: "Seed MediaPipe Pose Balanced",
      resources: { cpu: 2, gpu: 0, vramMb: 0 },
      defaults: { minConfidence: 0.5 },
      outputs: { keypoints: true },
      status: "active"
    }
  },
  nodes: {
    detectionValidation: {
      nodeId: "seed-node-nhdp21-validation",
      endpoint: "http://seed-node-nhdp21-validation:8091",
      capabilityId: "faces",
      taskTypes: ["face_detection"],
      qualities: ["balanced"]
    },
    detectionTopologyPrimary: {
      nodeId: "seed-node-nhdp21-topology-primary",
      endpoint: "http://seed-node-nhdp21-topology-primary:8091",
      capabilityId: "people",
      taskTypes: ["person_detection"],
      qualities: ["balanced"],
      status: "online",
      queueDepth: 0
    },
    detectionTopologyFallback: {
      nodeId: "seed-node-nhdp21-topology-fallback",
      endpoint: "http://seed-node-nhdp21-topology-fallback:8091",
      capabilityId: "people",
      taskTypes: ["person_detection"],
      qualities: ["balanced"],
      status: "degraded",
      queueDepth: 2
    },
    adminBrowserPrimary: {
      nodeId: "seed-node-admin-browser-primary",
      endpoint: "http://seed-node-admin-browser-primary:8091",
      capabilityId: "people",
      taskTypes: ["person_detection"],
      qualities: ["balanced"],
      status: "online",
      queueDepth: 0
    },
    portalBrowserPrimary: {
      nodeId: "seed-node-portal-browser-primary",
      endpoint: "http://seed-node-portal-browser-primary:8091",
      capabilityId: "people",
      taskTypes: ["person_detection"],
      qualities: ["balanced"],
      status: "online",
      queueDepth: 0
    }
  },
  pipelines: {
    detectionJobsFace: {
      pipelineId: "faces-main",
      provider: "yolo",
      taskType: "face_detection",
      quality: "balanced",
      enabled: true,
      schedule: { mode: "realtime", frameStride: 12 },
      thresholds: { minConfidence: 0.7 },
      outputs: { storeFaceCrops: true, storeEmbeddings: true }
    },
    detectionValidationFace: {
      pipelineId: "faces-main",
      provider: "yolo",
      taskType: "face_detection",
      quality: "balanced",
      enabled: true,
      schedule: { mode: "realtime", frameStride: 10 },
      thresholds: {},
      outputs: {}
    },
    detectionTopologyPeople: {
      pipelineId: "people-main",
      provider: "yolo",
      taskType: "person_detection",
      quality: "balanced",
      enabled: true,
      schedule: { mode: "realtime", frameStride: 6 },
      thresholds: {},
      outputs: {}
    },
    adminBrowserReadyPeople: {
      pipelineId: "people-ready",
      provider: "yolo",
      taskType: "person_detection",
      quality: "balanced",
      enabled: true,
      schedule: { mode: "realtime", frameStride: 4 },
      thresholds: { minConfidence: 0.65 },
      outputs: { storeClips: false }
    },
    adminBrowserAttentionPose: {
      pipelineId: "pose-attention",
      provider: "mediapipe",
      taskType: "pose_estimation",
      quality: "balanced",
      enabled: true,
      schedule: { mode: "realtime", frameStride: 8 },
      thresholds: { minConfidence: 0.5 },
      outputs: { keypoints: true }
    },
    portalBrowserReadyPeople: {
      pipelineId: "people-portal-main",
      provider: "yolo",
      taskType: "person_detection",
      quality: "balanced",
      enabled: true,
      schedule: { mode: "realtime", frameStride: 5 },
      thresholds: { minConfidence: 0.6 },
      outputs: { storeClips: false }
    }
  }
} as const;

export type SeedFixtures = typeof seedFixtures;
