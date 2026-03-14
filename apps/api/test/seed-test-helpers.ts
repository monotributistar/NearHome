import type { PrismaClient } from "@prisma/client";
import { seedFixtures } from "../prisma/seed-fixtures.js";

export async function requireTenantId(prisma: PrismaClient, name: string): Promise<string> {
  const tenant = await prisma.tenant.findFirst({ where: { name } });
  if (!tenant) {
    throw new Error(`Missing seeded tenant: ${name}`);
  }
  return tenant.id;
}

export async function requireCameraId(prisma: PrismaClient, tenantId: string, name: string): Promise<string> {
  const camera = await prisma.camera.findFirst({ where: { tenantId, name } });
  if (!camera) {
    throw new Error(`Missing seeded camera: ${name}`);
  }
  return camera.id;
}

export async function getSeedDetectionJobsFixture(prisma: PrismaClient) {
  const tenantId = await requireTenantId(prisma, seedFixtures.tenants.detectionJobs);
  const cameraId = await requireCameraId(prisma, tenantId, seedFixtures.cameras.detectionJobs.name);
  return {
    tenantId,
    cameraId,
    modelRef: seedFixtures.modelCatalog.detectionJobsFace.modelRef,
    pipelineId: seedFixtures.pipelines.detectionJobsFace.pipelineId
  };
}

export async function getSeedDetectionValidationFixture(prisma: PrismaClient) {
  const tenantId = await requireTenantId(prisma, seedFixtures.tenants.detectionValidation);
  const cameraId = await requireCameraId(prisma, tenantId, seedFixtures.cameras.detectionValidation.name);
  return {
    tenantId,
    cameraId,
    modelRef: seedFixtures.modelCatalog.detectionValidationFace.modelRef,
    pipelineId: seedFixtures.pipelines.detectionValidationFace.pipelineId,
    nodeId: seedFixtures.nodes.detectionValidation.nodeId
  };
}

export async function getSeedDetectionTopologyFixture(prisma: PrismaClient) {
  const tenantId = await requireTenantId(prisma, seedFixtures.tenants.detectionTopology);
  const cameraId = await requireCameraId(prisma, tenantId, seedFixtures.cameras.detectionTopology.name);
  return {
    tenantId,
    cameraId,
    modelRef: seedFixtures.modelCatalog.detectionTopologyPeople.modelRef,
    pipelineId: seedFixtures.pipelines.detectionTopologyPeople.pipelineId,
    preferredNodeId: seedFixtures.nodes.detectionTopologyPrimary.nodeId,
    fallbackNodeId: seedFixtures.nodes.detectionTopologyFallback.nodeId
  };
}

export async function getSeedFacesFixture(prisma: PrismaClient) {
  const tenantId = await requireTenantId(prisma, seedFixtures.tenants.faces);
  const cameraId = await requireCameraId(prisma, tenantId, seedFixtures.cameras.faces.name);
  return { tenantId, cameraId };
}

export async function clearDetectionStateForCamera(prisma: PrismaClient, tenantId: string, cameraId: string) {
  const observationIds = (
    await prisma.detectionObservation.findMany({
      where: { tenantId, cameraId },
      select: { id: true }
    })
  ).map((row) => row.id);

  await prisma.$transaction(async (tx) => {
    await (tx as any).faceIdentityMergeLog.deleteMany({ where: { tenantId } });
    await (tx as any).faceIdentityMember.deleteMany({ where: { tenantId } });
    await (tx as any).faceClusterMember.deleteMany({ where: { tenantId } });
    await (tx as any).faceEmbedding.deleteMany({ where: { tenantId } });
    await (tx as any).faceDetection.deleteMany({ where: { tenantId, cameraId } });
    await (tx as any).faceCluster.deleteMany({ where: { tenantId } });
    await (tx as any).faceIdentity.deleteMany({ where: { tenantId } });

    if (observationIds.length > 0) {
      await tx.detectionObservation.deleteMany({ where: { id: { in: observationIds } } });
    }
    await tx.detectionJob.deleteMany({ where: { tenantId, cameraId } });
  });
}
