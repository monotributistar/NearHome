import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
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

  const [tenantA, tenantB, tenantC] = await Promise.all([
    prisma.tenant.create({ data: { name: "Acme Retail" } }),
    prisma.tenant.create({ data: { name: "Beta Logistics" } }),
    prisma.tenant.create({ data: { name: "Gamma Clinics" } })
  ]);

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
      { tenantId: tenantC.id, userId: admin.id, role: "tenant_admin" }
    ]
  });

  const [camA1, camA2, camA3, camA4, camA5, camB1, camB2] = await Promise.all([
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
    })
  ]);

  const allCameras = [camA1, camA2, camA3, camA4, camA5, camB1, camB2];
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
        limits: JSON.stringify({ maxCameras: 50, retentionDays: 30, maxConcurrentStreams: 10 }),
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

  console.log("Seed ready");
  console.log("Users: admin@nearhome.dev / monitor@nearhome.dev / client@nearhome.dev");
  console.log("Password for all: demo1234");
  console.log("Plans:", starter.code, basic.code, pro.code);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
