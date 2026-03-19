export const seedAdminBrowser = {
  tenantName: "Seed Admin Browser",
  cameraNames: {
    ready: "Seed Admin Ready Cam",
    attention: "Seed Admin Attention Cam",
    idle: "Seed Admin Idle Cam"
  },
  faceLabels: {
    open: "admin-open-face.jpg",
    mergeSource: "admin-merge-source.jpg"
  },
  identityNames: {
    maria: "Maria Gomez",
    carlos: "Carlos Perez",
    mergeSource: "Caso Origen",
    mergeTarget: "Caso Destino"
  },
  pipelineLabels: {
    ready: "Personas",
    attention: "Postura"
  },
  nodeIds: {
    primary: "seed-node-admin-browser-primary"
  },
  routes: {
    clientOverview: "/resources/client-overview",
    faceCases: "/resources/faces",
    nodes: "/operations/nodes"
  }
} as const;

export const seedPortalBrowser = {
  tenantName: "Seed Portal Browser",
  scopeTenantNames: {
    a: "Seed Portal Scope A",
    b: "Seed Portal Scope B"
  },
  cameraNames: {
    ready: "Seed Portal Ready Cam",
    entry: "Seed Portal Entry Cam",
    scopeA: "Seed Portal Scope Cam A",
    scopeB: "Seed Portal Scope Cam B"
  },
  requestFileName: "seed-portal-proof.jpg",
  routes: {
    cameras: "/operations/cameras",
    events: "/operations/events",
    realtime: "/operations/realtime",
    subscriptions: "/account/subscriptions"
  }
} as const;
