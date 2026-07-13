// Seed script for NearHome POC - creates 2 tenants with RTSP cameras
// Run: docker compose -f infra/docker-compose.poc.yml cp seed-poc.ts api:/app/ && docker compose exec -T api npx tsx seed-poc.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Tenant A - Oficinas Corporativas
  const tenantA = await prisma.tenant.upsert({
    where: { id: "tenant-a-oficinas" },
    update: { name: "Oficinas Corporativas" },
    create: {
      id: "tenant-a-oficinas",
      name: "Oficinas Corporativas",
    },
  });
  console.log(`Tenant A: ${tenantA.id} - ${tenantA.name}`);

  // Tenant A cameras
  const camA1 = await prisma.camera.upsert({
    where: { id: "cam-a-entrada" },
    update: {
      rtspUrl: "rtsp://host.docker.internal:8554/entrance-frontal",
      isActive: true,
      lifecycleStatus: "active",
    },
    create: {
      id: "cam-a-entrada",
      tenantId: tenantA.id,
      name: "Entrada Principal",
      rtspUrl: "rtsp://host.docker.internal:8554/entrance-frontal",
      location: "Puerta de entrada - vista frontal",
      tags: JSON.stringify(["entrada", "puerta"]),
      isActive: true,
      lifecycleStatus: "active",
    },
  });
  const camA2 = await prisma.camera.upsert({
    where: { id: "cam-a-pasillo" },
    update: {
      rtspUrl: "rtsp://host.docker.internal:8554/entrance-corridor",
      isActive: true,
      lifecycleStatus: "active",
    },
    create: {
      id: "cam-a-pasillo",
      tenantId: tenantA.id,
      name: "Pasillo Recepción",
      rtspUrl: "rtsp://host.docker.internal:8554/entrance-corridor",
      location: "Pasillo interior - recepción",
      tags: JSON.stringify(["pasillo", "interior"]),
      isActive: true,
      lifecycleStatus: "active",
    },
  });
  const camA3 = await prisma.camera.upsert({
    where: { id: "cam-a-estacionamiento" },
    update: {
      rtspUrl: "rtsp://host.docker.internal:8554/towncentre",
      isActive: true,
      lifecycleStatus: "active",
    },
    create: {
      id: "cam-a-estacionamiento",
      tenantId: tenantA.id,
      name: "Vista Exterior",
      rtspUrl: "rtsp://host.docker.internal:8554/towncentre",
      location: "Exterior - calle peatonal",
      tags: JSON.stringify(["exterior", "calle"]),
      isActive: true,
      lifecycleStatus: "active",
    },
  });
  console.log(`  Cameras: ${camA1.name}, ${camA2.name}, ${camA3.name}`);

  // Tenant B - Deposito Logistica
  const tenantB = await prisma.tenant.upsert({
    where: { id: "tenant-b-logistica" },
    update: { name: "Depósito Logística" },
    create: {
      id: "tenant-b-logistica",
      name: "Depósito Logística",
    },
  });
  console.log(`Tenant B: ${tenantB.id} - ${tenantB.name}`);

  const camB1 = await prisma.camera.upsert({
    where: { id: "cam-b-ingreso" },
    update: {
      rtspUrl: "rtsp://host.docker.internal:8554/pets-campus",
      isActive: true,
      lifecycleStatus: "active",
    },
    create: {
      id: "cam-b-ingreso",
      tenantId: tenantB.id,
      name: "Ingreso Vehicular",
      rtspUrl: "rtsp://host.docker.internal:8554/pets-campus",
      location: "Puerta de ingreso - exterior",
      tags: JSON.stringify(["ingreso", "exterior"]),
      isActive: true,
      lifecycleStatus: "active",
    },
  });
  const camB2 = await prisma.camera.upsert({
    where: { id: "cam-b-bodega" },
    update: {
      rtspUrl: "rtsp://host.docker.internal:8554/mall-interior",
      isActive: true,
      lifecycleStatus: "active",
    },
    create: {
      id: "cam-b-bodega",
      tenantId: tenantB.id,
      name: "Bodega Principal",
      rtspUrl: "rtsp://host.docker.internal:8554/mall-interior",
      location: "Interior de bodega",
      tags: JSON.stringify(["bodega", "interior"]),
      isActive: true,
      lifecycleStatus: "active",
    },
  });
  const camB3 = await prisma.camera.upsert({
    where: { id: "cam-b-muelle" },
    update: {
      rtspUrl: "rtsp://host.docker.internal:8554/browse-tienda",
      isActive: true,
      lifecycleStatus: "active",
    },
    create: {
      id: "cam-b-muelle",
      tenantId: tenantB.id,
      name: "Muelle de Carga",
      rtspUrl: "rtsp://host.docker.internal:8554/browse-tienda",
      location: "Muelle de carga - zona operativa",
      tags: JSON.stringify(["muelle", "operaciones"]),
      isActive: true,
      lifecycleStatus: "active",
    },
  });
  console.log(`  Cameras: ${camB1.name}, ${camB2.name}, ${camB3.name}`);

  // Verify
  const totalCameras = await prisma.camera.count();
  const totalTenants = await prisma.tenant.count();
  console.log(`\nTotal: ${totalTenants} tenants, ${totalCameras} cameras`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
