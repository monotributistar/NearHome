import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedFixtures } from "./seed-fixtures.js";

const prisma = new PrismaClient();
const prismaUnsafe = prisma as any;

async function main() {
  await prisma.incidentEvidence.deleteMany();
  await prisma.incidentEvent.deleteMany();
  await prisma.scenePrimitiveEvent.deleteMany();
  await prisma.trackPoint.deleteMany();
  await prisma.track.deleteMany();
  await prismaUnsafe.faceIdentityMergeLog.deleteMany();
  await prismaUnsafe.faceIdentityMember.deleteMany();
  await prismaUnsafe.faceClusterMember.deleteMany();
  await prismaUnsafe.faceEmbedding.deleteMany();
  await prismaUnsafe.faceDetection.deleteMany();
  await prismaUnsafe.faceCluster.deleteMany();
  await prismaUnsafe.faceIdentity.deleteMany();
  await prisma.detectionObservation.deleteMany();
  await prisma.detectionJob.deleteMany();
  await prisma.inferenceNodeDesiredConfig.deleteMany();
  await prisma.inferenceNodeTenantAssignment.deleteMany();
  await prisma.inferenceNodeSnapshot.deleteMany();
  await prisma.inferenceProviderConfig.deleteMany();
  await prisma.modelCatalogEntry.deleteMany();
  await prisma.event.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.streamSessionTransition.deleteMany();
  await prisma.streamSession.deleteMany();
  await prisma.cameraProfile.deleteMany();
  await prisma.cameraLifecycleLog.deleteMany();
  await prisma.cameraHealthSnapshot.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.camera.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();

  const tenantA = await prisma.tenant.create({ data: { name: seedFixtures.tenants.acme } });
  const tenantB = await prisma.tenant.create({ data: { name: seedFixtures.tenants.beta } });
  const tenantC = await prisma.tenant.create({ data: { name: seedFixtures.tenants.gamma } });
  const tenantDetectionJobs = await prisma.tenant.create({ data: { name: seedFixtures.tenants.detectionJobs } });
  const tenantDetectionValidation = await prisma.tenant.create({ data: { name: seedFixtures.tenants.detectionValidation } });
  const tenantDetectionTopology = await prisma.tenant.create({ data: { name: seedFixtures.tenants.detectionTopology } });
  const tenantFaces = await prisma.tenant.create({ data: { name: seedFixtures.tenants.faces } });
  const tenantAdminBrowser = await prisma.tenant.create({ data: { name: seedFixtures.tenants.adminBrowser } });
  const tenantPortalBrowser = await prisma.tenant.create({ data: { name: seedFixtures.tenants.portalBrowser } });
  const tenantPortalScopeA = await prisma.tenant.create({ data: { name: seedFixtures.tenants.portalScopeA } });
  const tenantPortalScopeB = await prisma.tenant.create({ data: { name: seedFixtures.tenants.portalScopeB } });

  const passwordHash = await bcrypt.hash("demo1234", 10);

  const [admin, monitor, clientUser] = await Promise.all([
    prisma.user.create({ data: { email: "admin@nearhome.dev", name: "Admin User", passwordHash, isActive: true } }),
    prisma.user.create({ data: { email: "monitor@nearhome.dev", name: "Monitor User", passwordHash, isActive: true } }),
    prisma.user.create({ data: { email: "client@nearhome.dev", name: "Client User", passwordHash, isActive: true } })
  ]);

  await prisma.membership.createMany({
    data: [
      { tenantId: tenantA.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantA.id, userId: monitor.id, role: "monitor" },
      { tenantId: tenantA.id, userId: clientUser.id, role: "client_user" },
      { tenantId: tenantB.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantC.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantDetectionJobs.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantDetectionValidation.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantDetectionTopology.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantDetectionTopology.id, userId: monitor.id, role: "monitor" },
      { tenantId: tenantDetectionTopology.id, userId: clientUser.id, role: "client_user" },
      { tenantId: tenantFaces.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantAdminBrowser.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantAdminBrowser.id, userId: monitor.id, role: "monitor" },
      { tenantId: tenantAdminBrowser.id, userId: clientUser.id, role: "client_user" },
      { tenantId: tenantPortalBrowser.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantPortalBrowser.id, userId: monitor.id, role: "monitor" },
      { tenantId: tenantPortalBrowser.id, userId: clientUser.id, role: "client_user" },
      { tenantId: tenantPortalScopeA.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantPortalScopeA.id, userId: monitor.id, role: "monitor" },
      { tenantId: tenantPortalScopeA.id, userId: clientUser.id, role: "client_user" },
      { tenantId: tenantPortalScopeB.id, userId: admin.id, role: "tenant_admin" },
      { tenantId: tenantPortalScopeB.id, userId: monitor.id, role: "monitor" }
    ]
  });

  const [
    camA1,
    camA2,
    camA3,
    camA4,
    camA5,
    camB1,
    camB2,
    camC1,
    camDetectionJobs,
    camDetectionValidation,
    camDetectionTopology,
    camFaces,
    camAdminBrowserReady,
    camAdminBrowserAttention,
    camAdminBrowserIdle,
    camPortalBrowserReady,
    camPortalBrowserEntry,
    camPortalScopeA,
    camPortalScopeB
  ] = await Promise.all([
    prisma.camera.create({
      data: {
        tenantId: tenantA.id,
        name: "Front Door",
        description: "Main entrance coverage for visitors and deliveries",
        rtspUrl: "rtsp://demo/a1",
        location: "Entrance",
        tags: JSON.stringify(["entry", "public"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantA.id,
        name: "Warehouse",
        description: "Stock area aisle monitoring",
        rtspUrl: "rtsp://demo/a2",
        location: "Warehouse",
        tags: JSON.stringify(["stock"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantA.id,
        name: "Parking",
        description: "Outdoor parking lot overview",
        rtspUrl: "rtsp://demo/a3",
        location: "Parking",
        tags: JSON.stringify(["outdoor"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantA.id,
        name: "Back Office",
        description: "Back office internal access",
        rtspUrl: "rtsp://demo/a4",
        location: "Office",
        tags: JSON.stringify(["staff"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantA.id,
        name: "Cashier",
        description: "Checkout line and POS security",
        rtspUrl: "rtsp://demo/a5",
        location: "POS",
        tags: JSON.stringify(["sensitive"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantB.id,
        name: "Dock 1",
        description: "Dock gate lane 1",
        rtspUrl: "rtsp://demo/b1",
        location: "Dock",
        tags: JSON.stringify(["logistics"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantB.id,
        name: "Dock 2",
        description: "Dock gate lane 2",
        rtspUrl: "rtsp://demo/b2",
        location: "Dock",
        tags: JSON.stringify(["logistics"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantC.id,
        name: "Lobby",
        description: "Reception and waiting area",
        rtspUrl: "rtsp://demo/c1",
        location: "Lobby",
        tags: JSON.stringify(["reception"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantDetectionJobs.id,
        name: seedFixtures.cameras.detectionJobs.name,
        description: "Fixture camera for seeded detection job resolution tests",
        rtspUrl: seedFixtures.cameras.detectionJobs.rtspUrl,
        location: "Fixture Lab",
        tags: JSON.stringify(["seed", "detection-jobs"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantDetectionValidation.id,
        name: seedFixtures.cameras.detectionValidation.name,
        description: "Fixture camera for seeded validation tests",
        rtspUrl: seedFixtures.cameras.detectionValidation.rtspUrl,
        location: "Fixture Lab",
        tags: JSON.stringify(["seed", "validation"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantDetectionTopology.id,
        name: seedFixtures.cameras.detectionTopology.name,
        description: "Fixture camera for seeded topology tests",
        rtspUrl: seedFixtures.cameras.detectionTopology.rtspUrl,
        location: "Fixture Lab",
        tags: JSON.stringify(["seed", "topology"]),
        isActive: true,
        lifecycleStatus: "provisioning",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantFaces.id,
        name: seedFixtures.cameras.faces.name,
        description: "Fixture camera for seeded face identity tests",
        rtspUrl: seedFixtures.cameras.faces.rtspUrl,
        location: "Fixture Lab",
        tags: JSON.stringify(["seed", "faces"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantAdminBrowser.id,
        name: seedFixtures.cameras.adminBrowserReady.name,
        description: "Fixture camera for seeded admin browser ready state",
        rtspUrl: seedFixtures.cameras.adminBrowserReady.rtspUrl,
        location: "Seed Browser Lab",
        tags: JSON.stringify(["seed", "browser", "ready"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantAdminBrowser.id,
        name: seedFixtures.cameras.adminBrowserAttention.name,
        description: "Fixture camera for seeded admin browser attention state",
        rtspUrl: seedFixtures.cameras.adminBrowserAttention.rtspUrl,
        location: "Seed Browser Lab",
        tags: JSON.stringify(["seed", "browser", "attention"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantAdminBrowser.id,
        name: seedFixtures.cameras.adminBrowserIdle.name,
        description: "Fixture camera for seeded admin browser idle state",
        rtspUrl: seedFixtures.cameras.adminBrowserIdle.rtspUrl,
        location: "Seed Browser Lab",
        tags: JSON.stringify(["seed", "browser", "idle"]),
        isActive: true,
        lifecycleStatus: "draft",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantPortalBrowser.id,
        name: seedFixtures.cameras.portalBrowserReady.name,
        description: "Fixture camera for portal seeded ready flow",
        rtspUrl: seedFixtures.cameras.portalBrowserReady.rtspUrl,
        location: "Portal Seed Lobby",
        tags: JSON.stringify(["seed", "portal", "ready"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantPortalBrowser.id,
        name: seedFixtures.cameras.portalBrowserEntry.name,
        description: "Fixture camera for portal seeded events flow",
        rtspUrl: seedFixtures.cameras.portalBrowserEntry.rtspUrl,
        location: "Portal Seed Entry",
        tags: JSON.stringify(["seed", "portal", "entry"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantPortalScopeA.id,
        name: seedFixtures.cameras.portalScopeA.name,
        description: "Fixture camera for portal tenant scope A",
        rtspUrl: seedFixtures.cameras.portalScopeA.rtspUrl,
        location: "Portal Scope A",
        tags: JSON.stringify(["seed", "portal", "scope-a"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    }),
    prisma.camera.create({
      data: {
        tenantId: tenantPortalScopeB.id,
        name: seedFixtures.cameras.portalScopeB.name,
        description: "Fixture camera for portal tenant scope B",
        rtspUrl: seedFixtures.cameras.portalScopeB.rtspUrl,
        location: "Portal Scope B",
        tags: JSON.stringify(["seed", "portal", "scope-b"]),
        isActive: true,
        lifecycleStatus: "ready",
        lastSeenAt: new Date(),
        lastTransitionAt: new Date()
      }
    })
  ]);

  const allCameras = [
    camA1,
    camA2,
    camA3,
    camA4,
    camA5,
    camB1,
    camB2,
    camC1,
    camDetectionJobs,
    camDetectionValidation,
    camDetectionTopology,
    camFaces,
    camAdminBrowserReady,
    camAdminBrowserAttention,
    camAdminBrowserIdle,
    camPortalBrowserReady,
    camPortalBrowserEntry,
    camPortalScopeA,
    camPortalScopeB
  ];
  await Promise.all(
    allCameras.map((camera) =>
      prisma.cameraProfile.create({
        data: {
          tenantId: camera.tenantId,
          cameraId: camera.id,
          proxyPath: `/proxy/live/${camera.tenantId}/${camera.id}`,
          recordingEnabled: true,
          recordingStorageKey: `s3://nearhome/${camera.tenantId}/recordings/${camera.id}`,
          detectorConfigKey: `kv://nearhome/${camera.tenantId}/detectors/${camera.id}/config.json`,
          detectorResultsKey: `s3://nearhome/${camera.tenantId}/detectors/${camera.id}/results`,
          detectorFlags: JSON.stringify({ mediapipe: true, yolo: true, lpr: false }),
          status: "ready",
          lastHealthAt: new Date(),
          lastError: null
        }
      })
    )
  );

  await prisma.cameraProfile.update({
    where: { cameraId: camDetectionJobs.id },
    data: {
      detectionProfile: JSON.stringify({
        pipelines: [seedFixtures.pipelines.detectionJobsFace]
      })
    }
  });

  await prisma.cameraProfile.update({
    where: { cameraId: camDetectionValidation.id },
    data: {
      detectionProfile: JSON.stringify({
        pipelines: [seedFixtures.pipelines.detectionValidationFace]
      })
    }
  });

  await prisma.cameraProfile.update({
    where: { cameraId: camDetectionTopology.id },
    data: {
      detectionProfile: JSON.stringify({
        pipelines: [seedFixtures.pipelines.detectionTopologyPeople]
      })
    }
  });

  await prisma.cameraProfile.update({
    where: { cameraId: camAdminBrowserReady.id },
    data: {
      detectionProfile: JSON.stringify({
        pipelines: [seedFixtures.pipelines.adminBrowserReadyPeople]
      })
    }
  });

  await prisma.cameraProfile.update({
    where: { cameraId: camAdminBrowserAttention.id },
    data: {
      detectionProfile: JSON.stringify({
        pipelines: [seedFixtures.pipelines.adminBrowserAttentionPose]
      })
    }
  });

  await prisma.cameraProfile.update({
    where: { cameraId: camPortalBrowserReady.id },
    data: {
      detectionProfile: JSON.stringify({
        pipelines: [seedFixtures.pipelines.portalBrowserReadyPeople]
      })
    }
  });

  await Promise.all(
    allCameras.map((camera) =>
      prisma.cameraHealthSnapshot.create({
        data: {
          tenantId: camera.tenantId,
          cameraId: camera.id,
          connectivity: "online",
          latencyMs: 120,
          packetLossPct: 0.2,
          jitterMs: 8,
          checkedAt: new Date()
        }
      })
    )
  );

  await Promise.all(
    allCameras.map((camera) =>
      prisma.cameraLifecycleLog.create({
        data: {
          tenantId: camera.tenantId,
          cameraId: camera.id,
          fromStatus: null,
          toStatus: "ready",
          event: "camera.seeded_ready",
          reason: "seed initialization",
          actorUserId: admin.id
        }
      })
    )
  );

  await prisma.cameraLifecycleLog.create({
    data: {
      tenantId: tenantDetectionTopology.id,
      cameraId: camDetectionTopology.id,
      fromStatus: "provisioning",
      toStatus: "provisioning",
      event: "camera.profile_configured",
      reason: "seed initialization",
      actorUserId: admin.id
    }
  });

  const [starter, basic, pro] = await Promise.all([
    prisma.plan.create({
      data: {
        code: "starter",
        name: "Starter",
        limits: JSON.stringify({ maxCameras: 2, retentionDays: 1, maxConcurrentStreams: 1 }),
        features: JSON.stringify({ mediapipe: true, yolo: false, lpr: false })
      }
    }),
    prisma.plan.create({
      data: {
        code: "basic",
        name: "Basic",
        limits: JSON.stringify({ maxCameras: 10, retentionDays: 7, maxConcurrentStreams: 2 }),
        features: JSON.stringify({ mediapipe: true, yolo: false, lpr: false })
      }
    }),
    prisma.plan.create({
      data: {
        code: "pro",
        name: "Pro",
        limits: JSON.stringify({ maxCameras: 500, retentionDays: 30, maxConcurrentStreams: 10 }),
        features: JSON.stringify({ mediapipe: true, yolo: true, lpr: true })
      }
    })
  ]);

  await prisma.subscription.create({
    data: {
      tenantId: tenantA.id,
      planId: pro.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantB.id,
      planId: starter.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantC.id,
      planId: basic.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantDetectionJobs.id,
      planId: pro.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantDetectionValidation.id,
      planId: pro.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantDetectionTopology.id,
      planId: pro.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantFaces.id,
      planId: pro.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      planId: pro.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantPortalBrowser.id,
      planId: pro.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantPortalScopeA.id,
      planId: basic.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenantPortalScopeB.id,
      planId: basic.id,
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    }
  });

  await prisma.modelCatalogEntry.createMany({
    data: [
      seedFixtures.modelCatalog.detectionJobsFace,
      seedFixtures.modelCatalog.detectionTopologyPeople,
      seedFixtures.modelCatalog.adminBrowserPose
    ].map((entry) => ({
      provider: entry.provider,
      taskType: entry.taskType,
      quality: entry.quality,
      modelRef: entry.modelRef,
      displayName: entry.displayName,
      resources: JSON.stringify(entry.resources),
      defaults: JSON.stringify(entry.defaults),
      outputs: JSON.stringify(entry.outputs),
      status: entry.status
    }))
  });

  await prisma.inferenceNodeSnapshot.create({
    data: {
      tenantId: tenantDetectionValidation.id,
      nodeId: seedFixtures.nodes.detectionValidation.nodeId,
      runtime: "yolo",
      transport: "http",
      endpoint: seedFixtures.nodes.detectionValidation.endpoint,
      status: "offline",
      resources: JSON.stringify({ cpu: 4, gpu: 0, vramMb: 0 }),
      capabilities: JSON.stringify([
        {
          capabilityId: seedFixtures.nodes.detectionValidation.capabilityId,
          taskTypes: seedFixtures.nodes.detectionValidation.taskTypes,
          qualities: seedFixtures.nodes.detectionValidation.qualities,
          modelRefs: [seedFixtures.modelCatalog.detectionValidationFace.modelRef]
        }
      ]),
      models: JSON.stringify([seedFixtures.modelCatalog.detectionValidationFace.modelRef]),
      maxConcurrent: 2,
      queueDepth: 0,
      isDrained: false,
      lastHeartbeatAt: new Date(),
      contractVersion: "1.0"
    }
  });
  await prisma.inferenceNodeDesiredConfig.create({
    data: {
      nodeId: seedFixtures.nodes.detectionValidation.nodeId,
      runtime: "yolo",
      transport: "http",
      endpoint: seedFixtures.nodes.detectionValidation.endpoint,
      desiredResources: JSON.stringify({ cpu: 4, gpu: 0, vramMb: 0 }),
      desiredModels: JSON.stringify([seedFixtures.modelCatalog.detectionValidationFace.modelRef]),
      desiredCapabilities: JSON.stringify([
        {
          capabilityId: seedFixtures.nodes.detectionValidation.capabilityId,
          taskTypes: seedFixtures.nodes.detectionValidation.taskTypes,
          qualities: seedFixtures.nodes.detectionValidation.qualities,
          modelRefs: [seedFixtures.modelCatalog.detectionValidationFace.modelRef]
        }
      ]),
      desiredTenantIds: JSON.stringify([tenantDetectionValidation.id]),
      maxConcurrent: 2,
      contractVersion: "1.0"
    }
  });
  await prisma.inferenceNodeTenantAssignment.create({
    data: {
      nodeId: seedFixtures.nodes.detectionValidation.nodeId,
      tenantId: tenantDetectionValidation.id
    }
  });

  for (const topologyNode of [seedFixtures.nodes.detectionTopologyPrimary, seedFixtures.nodes.detectionTopologyFallback]) {
    await prisma.inferenceNodeSnapshot.create({
      data: {
        tenantId: tenantDetectionTopology.id,
        nodeId: topologyNode.nodeId,
        runtime: "yolo",
        transport: "http",
        endpoint: topologyNode.endpoint,
        status: topologyNode.status,
        resources: JSON.stringify({ cpu: 4, gpu: 0, vramMb: 0 }),
        capabilities: JSON.stringify([
          {
            capabilityId: topologyNode.capabilityId,
            taskTypes: topologyNode.taskTypes,
            qualities: topologyNode.qualities,
            modelRefs: [seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]
          }
        ]),
        models: JSON.stringify([seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]),
        maxConcurrent: 4,
        queueDepth: topologyNode.queueDepth,
        isDrained: false,
        lastHeartbeatAt: new Date(),
        contractVersion: "1.0"
      }
    });
    await prisma.inferenceNodeDesiredConfig.create({
      data: {
        nodeId: topologyNode.nodeId,
        runtime: "yolo",
        transport: "http",
        endpoint: topologyNode.endpoint,
        desiredResources: JSON.stringify({ cpu: 4, gpu: 0, vramMb: 0 }),
        desiredModels: JSON.stringify([seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]),
        desiredCapabilities: JSON.stringify([
          {
            capabilityId: topologyNode.capabilityId,
            taskTypes: topologyNode.taskTypes,
            qualities: topologyNode.qualities,
            modelRefs: [seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]
          }
        ]),
        desiredTenantIds: JSON.stringify([tenantDetectionTopology.id]),
        maxConcurrent: 4,
        contractVersion: "1.0"
      }
    });
    await prisma.inferenceNodeTenantAssignment.create({
      data: {
        nodeId: topologyNode.nodeId,
        tenantId: tenantDetectionTopology.id
      }
    });
  }

  await prisma.inferenceNodeSnapshot.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      nodeId: seedFixtures.nodes.adminBrowserPrimary.nodeId,
      runtime: "yolo",
      transport: "http",
      endpoint: seedFixtures.nodes.adminBrowserPrimary.endpoint,
      status: seedFixtures.nodes.adminBrowserPrimary.status,
      resources: JSON.stringify({ cpu: 4, gpu: 0, vramMb: 0 }),
      capabilities: JSON.stringify([
        {
          capabilityId: seedFixtures.nodes.adminBrowserPrimary.capabilityId,
          taskTypes: seedFixtures.nodes.adminBrowserPrimary.taskTypes,
          qualities: seedFixtures.nodes.adminBrowserPrimary.qualities,
          modelRefs: [seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]
        }
      ]),
      models: JSON.stringify([seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]),
      maxConcurrent: 3,
      queueDepth: seedFixtures.nodes.adminBrowserPrimary.queueDepth,
      isDrained: false,
      lastHeartbeatAt: new Date(),
      contractVersion: "1.0"
    }
  });
  await prisma.inferenceNodeDesiredConfig.create({
    data: {
      nodeId: seedFixtures.nodes.adminBrowserPrimary.nodeId,
      runtime: "yolo",
      transport: "http",
      endpoint: seedFixtures.nodes.adminBrowserPrimary.endpoint,
      desiredResources: JSON.stringify({ cpu: 4, gpu: 0, vramMb: 0 }),
      desiredModels: JSON.stringify([seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]),
      desiredCapabilities: JSON.stringify([
        {
          capabilityId: seedFixtures.nodes.adminBrowserPrimary.capabilityId,
          taskTypes: seedFixtures.nodes.adminBrowserPrimary.taskTypes,
          qualities: seedFixtures.nodes.adminBrowserPrimary.qualities,
          modelRefs: [seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]
        }
      ]),
      desiredTenantIds: JSON.stringify([tenantAdminBrowser.id]),
      maxConcurrent: 3,
      contractVersion: "1.0"
    }
  });
  await prisma.inferenceNodeTenantAssignment.create({
    data: {
      nodeId: seedFixtures.nodes.adminBrowserPrimary.nodeId,
      tenantId: tenantAdminBrowser.id
    }
  });

  await prisma.inferenceNodeSnapshot.create({
    data: {
      tenantId: tenantPortalBrowser.id,
      nodeId: seedFixtures.nodes.portalBrowserPrimary.nodeId,
      runtime: "yolo",
      transport: "http",
      endpoint: seedFixtures.nodes.portalBrowserPrimary.endpoint,
      status: seedFixtures.nodes.portalBrowserPrimary.status,
      resources: JSON.stringify({ cpu: 4, gpu: 0, vramMb: 0 }),
      capabilities: JSON.stringify([
        {
          capabilityId: seedFixtures.nodes.portalBrowserPrimary.capabilityId,
          taskTypes: seedFixtures.nodes.portalBrowserPrimary.taskTypes,
          qualities: seedFixtures.nodes.portalBrowserPrimary.qualities,
          modelRefs: [seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]
        }
      ]),
      models: JSON.stringify([seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]),
      maxConcurrent: 3,
      queueDepth: seedFixtures.nodes.portalBrowserPrimary.queueDepth,
      isDrained: false,
      lastHeartbeatAt: new Date(),
      contractVersion: "1.0"
    }
  });
  await prisma.inferenceNodeDesiredConfig.create({
    data: {
      nodeId: seedFixtures.nodes.portalBrowserPrimary.nodeId,
      runtime: "yolo",
      transport: "http",
      endpoint: seedFixtures.nodes.portalBrowserPrimary.endpoint,
      desiredResources: JSON.stringify({ cpu: 4, gpu: 0, vramMb: 0 }),
      desiredModels: JSON.stringify([seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]),
      desiredCapabilities: JSON.stringify([
        {
          capabilityId: seedFixtures.nodes.portalBrowserPrimary.capabilityId,
          taskTypes: seedFixtures.nodes.portalBrowserPrimary.taskTypes,
          qualities: seedFixtures.nodes.portalBrowserPrimary.qualities,
          modelRefs: [seedFixtures.modelCatalog.detectionTopologyPeople.modelRef]
        }
      ]),
      desiredTenantIds: JSON.stringify([tenantPortalBrowser.id]),
      maxConcurrent: 3,
      contractVersion: "1.0"
    }
  });
  await prisma.inferenceNodeTenantAssignment.create({
    data: {
      nodeId: seedFixtures.nodes.portalBrowserPrimary.nodeId,
      tenantId: tenantPortalBrowser.id
    }
  });

  const adminBrowserFaceJob = await prisma.detectionJob.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      cameraId: camAdminBrowserReady.id,
      mode: "realtime",
      source: "snapshot",
      provider: "onprem_bento",
      status: "succeeded",
      options: JSON.stringify({ taskType: "face_detection", seed: true }),
      queuedAt: new Date(Date.now() - 10 * 60 * 1000),
      startedAt: new Date(Date.now() - 9 * 60 * 1000),
      finishedAt: new Date(Date.now() - 8 * 60 * 1000),
      createdByUserId: admin.id
    }
  });

  const mariaIdentity = await prismaUnsafe.faceIdentity.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      displayName: "Maria Gomez",
      status: "confirmed"
    }
  });
  const carlosIdentity = await prismaUnsafe.faceIdentity.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      displayName: "Carlos Perez",
      status: "confirmed"
    }
  });
  const mergeSourceIdentity = await prismaUnsafe.faceIdentity.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      displayName: "Caso Origen",
      status: "confirmed"
    }
  });
  const mergeTargetIdentity = await prismaUnsafe.faceIdentity.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      displayName: "Caso Destino",
      status: "confirmed"
    }
  });

  const openCluster = await prismaUnsafe.faceCluster.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      status: "open",
      displayName: "Cluster pendiente",
      memberCount: 1
    }
  });
  const mariaCluster = await prismaUnsafe.faceCluster.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      status: "confirmed",
      displayName: "Maria Gomez",
      memberCount: 1,
      confirmedIdentityId: mariaIdentity.id
    }
  });
  const carlosCluster = await prismaUnsafe.faceCluster.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      status: "confirmed",
      displayName: "Carlos Perez",
      memberCount: 1,
      confirmedIdentityId: carlosIdentity.id
    }
  });
  const mergeSourceCluster = await prismaUnsafe.faceCluster.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      status: "confirmed",
      displayName: "Caso Origen",
      memberCount: 1,
      confirmedIdentityId: mergeSourceIdentity.id
    }
  });
  const mergeTargetCluster = await prismaUnsafe.faceCluster.create({
    data: {
      tenantId: tenantAdminBrowser.id,
      status: "confirmed",
      displayName: "Caso Destino",
      memberCount: 1,
      confirmedIdentityId: mergeTargetIdentity.id
    }
  });

  async function createSeedFace(args: {
    frameOffsetMinutes: number;
    cropStorageKey: string;
    embedding: number[];
    clusterId: string;
    identityId?: string;
  }) {
    const frameTs = new Date(Date.now() - args.frameOffsetMinutes * 60 * 1000);
    const observation = await prisma.detectionObservation.create({
      data: {
        jobId: adminBrowserFaceJob.id,
        tenantId: tenantAdminBrowser.id,
        cameraId: camAdminBrowserReady.id,
        frameTs,
        label: "face",
        confidence: 0.97,
        bbox: JSON.stringify({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
        attributes: JSON.stringify({ cropStorageKey: args.cropStorageKey }),
        providerMeta: JSON.stringify({ taskType: "face_detection", seed: true })
      }
    });
    const faceDetection = await prismaUnsafe.faceDetection.create({
      data: {
        tenantId: tenantAdminBrowser.id,
        cameraId: camAdminBrowserReady.id,
        observationId: observation.id,
        detectorProvider: "yolo",
        detectorTaskType: "face_detection",
        cropStorageKey: args.cropStorageKey,
        qualityScore: 0.95,
        bbox: JSON.stringify({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
        frameTs
      }
    });
    const vectorNorm = Math.sqrt(args.embedding.reduce((acc, value) => acc + value * value, 0));
    const embedding = await prismaUnsafe.faceEmbedding.create({
      data: {
        tenantId: tenantAdminBrowser.id,
        faceDetectionId: faceDetection.id,
        embeddingVector: JSON.stringify(args.embedding),
        embeddingModelRef: "seed-face-embedder-v1",
        embeddingVersion: "1.0",
        qualityScore: 0.95,
        vectorNorm,
        dimensions: args.embedding.length
      }
    });
    await prismaUnsafe.faceClusterMember.create({
      data: {
        tenantId: tenantAdminBrowser.id,
        clusterId: args.clusterId,
        faceDetectionId: faceDetection.id,
        faceEmbeddingId: embedding.id,
        similarityScore: 0.98
      }
    });
    if (args.identityId) {
      await prismaUnsafe.faceIdentityMember.create({
        data: {
          tenantId: tenantAdminBrowser.id,
          identityId: args.identityId,
          faceDetectionId: faceDetection.id,
          faceEmbeddingId: embedding.id,
          sourceClusterId: args.clusterId
        }
      });
    }
  }

  await createSeedFace({
    frameOffsetMinutes: 1,
    cropStorageKey: "s3://nearhome/faces/admin-open-face.jpg",
    embedding: [0.93, 0.07, 0, 0],
    clusterId: openCluster.id
  });
  await createSeedFace({
    frameOffsetMinutes: 2,
    cropStorageKey: "s3://nearhome/faces/admin-maria-face.jpg",
    embedding: [0.92, 0.08, 0, 0],
    clusterId: mariaCluster.id,
    identityId: mariaIdentity.id
  });
  await createSeedFace({
    frameOffsetMinutes: 3,
    cropStorageKey: "s3://nearhome/faces/admin-carlos-face.jpg",
    embedding: [0.9, 0.1, 0, 0],
    clusterId: carlosCluster.id,
    identityId: carlosIdentity.id
  });
  await createSeedFace({
    frameOffsetMinutes: 4,
    cropStorageKey: "s3://nearhome/faces/admin-merge-source.jpg",
    embedding: [0, 0, 0.93, 0.07],
    clusterId: mergeSourceCluster.id,
    identityId: mergeSourceIdentity.id
  });
  await createSeedFace({
    frameOffsetMinutes: 5,
    cropStorageKey: "s3://nearhome/faces/admin-merge-target.jpg",
    embedding: [0, 0, 0.91, 0.09],
    clusterId: mergeTargetCluster.id,
    identityId: mergeTargetIdentity.id
  });

  const camerasA = [camA1, camA2, camA3, camA4, camA5];
  const camerasB = [camB1, camB2];

  for (let i = 0; i < 20; i += 1) {
    const tenantId = i % 2 === 0 ? tenantA.id : tenantB.id;
    const camera = i % 2 === 0 ? camerasA[i % camerasA.length] : camerasB[i % camerasB.length];
    await prisma.event.create({
      data: {
        tenantId,
        cameraId: camera.id,
        type: i % 3 === 0 ? "intrusion" : "motion",
        severity: i % 5 === 0 ? "high" : i % 2 === 0 ? "medium" : "low",
        timestamp:
          tenantId === tenantB.id && i >= 15
            ? new Date(Date.now() - (2 + i) * 1000 * 60 * 60 * 24)
            : new Date(Date.now() - i * 1000 * 60 * 15),
        payload: JSON.stringify({ score: Math.random().toFixed(2), frameId: i })
      }
    });
  }

  for (const [camera, type, severity, minutesAgo] of [
    [camPortalBrowserReady, "intrusion", "high", 5],
    [camPortalBrowserEntry, "motion", "medium", 15],
    [camPortalScopeA, "motion", "low", 25],
    [camPortalScopeB, "intrusion", "medium", 35]
  ] as const) {
    await prisma.event.create({
      data: {
        tenantId: camera.tenantId,
        cameraId: camera.id,
        type,
        severity,
        timestamp: new Date(Date.now() - minutesAgo * 60 * 1000),
        payload: JSON.stringify({ source: "seed", cameraName: camera.name })
      }
    });
  }

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000);
  const seedSession = await prisma.streamSession.create({
    data: {
      tenantId: tenantA.id,
      cameraId: camA1.id,
      userId: monitor.id,
      status: "issued",
      token: Buffer.from(`${monitor.id}:${camA1.id}:${expiresAt.toISOString()}`).toString("base64"),
      expiresAt,
      issuedAt
    }
  });
  await prisma.streamSessionTransition.createMany({
    data: [
      {
        streamSessionId: seedSession.id,
        tenantId: tenantA.id,
        fromStatus: null,
        toStatus: "requested",
        event: "stream.requested",
        actorUserId: monitor.id
      },
      {
        streamSessionId: seedSession.id,
        tenantId: tenantA.id,
        fromStatus: "requested",
        toStatus: "issued",
        event: "stream.issued",
        actorUserId: monitor.id
      }
    ]
  });

  await prisma.subscriptionRequest.create({
    data: {
      tenantId: tenantPortalBrowser.id,
      planId: pro.id,
      requestedByUserId: clientUser.id,
      status: "pending_review",
      proofImageUrl: "https://cdn.nearhome.dev/seed/portal-proof.jpg",
      proofFileName: "seed-portal-proof.jpg",
      proofMimeType: "image/jpeg",
      proofSizeBytes: 128000,
      proofMetadata: JSON.stringify({ source: "seed" }),
      notes: "Solicitud seeded para browser e2e"
    }
  });

  console.log("Seed ready");
  console.log("Users: admin@nearhome.dev / monitor@nearhome.dev / client@nearhome.dev");
  console.log("Password for all: demo1234");
  console.log("Plans:", starter.code, basic.code, pro.code);
  console.log(
    "Seed fixtures:",
    seedFixtures.tenants.detectionJobs,
    seedFixtures.tenants.detectionValidation,
    seedFixtures.tenants.detectionTopology,
    seedFixtures.tenants.faces,
    seedFixtures.tenants.adminBrowser,
    seedFixtures.tenants.portalBrowser,
    seedFixtures.tenants.portalScopeA,
    seedFixtures.tenants.portalScopeB
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
