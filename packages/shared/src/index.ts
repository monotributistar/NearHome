import { z } from "zod";

export const RoleSchema = z.enum(["tenant_admin", "monitor", "client_user"]);
export type Role = z.infer<typeof RoleSchema>;

export const TenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string()
});

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  createdAt: z.string(),
  isActive: z.boolean()
});

export const MembershipSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  role: RoleSchema,
  createdAt: z.string(),
  user: UserSchema.optional(),
  tenant: TenantSchema.optional()
});

export const CameraSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  rtspUrl: z.string(),
  location: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  isActive: z.boolean(),
  lifecycleStatus: z.enum(["draft", "provisioning", "ready", "degraded", "offline", "error", "retired"]),
  lastSeenAt: z.string().nullable().optional(),
  lastTransitionAt: z.string().nullable().optional(),
  createdAt: z.string(),
  profile: z
    .object({
      id: z.string(),
      cameraId: z.string(),
      tenantId: z.string(),
      proxyPath: z.string(),
      recordingEnabled: z.boolean(),
      recordingStorageKey: z.string(),
      detectorConfigKey: z.string(),
      detectorResultsKey: z.string(),
      detectorFlags: z.object({
        mediapipe: z.boolean(),
        yolo: z.boolean(),
        lpr: z.boolean()
      }),
      status: z.enum(["pending", "ready", "error"]),
      configComplete: z.boolean(),
      lastHealthAt: z.string().nullable().optional(),
      lastError: z.string().nullable().optional(),
      createdAt: z.string(),
      updatedAt: z.string()
    })
    .optional()
});

export const PlanSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  limits: z.object({
    maxCameras: z.number(),
    retentionDays: z.number(),
    maxConcurrentStreams: z.number()
  }),
  features: z.object({
    mediapipe: z.boolean(),
    yolo: z.boolean(),
    lpr: z.boolean()
  })
});

export const SubscriptionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  planId: z.string(),
  status: z.enum(["active", "past_due", "canceled"]),
  currentPeriodStart: z.string(),
  currentPeriodEnd: z.string(),
  plan: PlanSchema.optional()
});

export const EntitlementsSchema = z.object({
  planCode: z.string(),
  limits: PlanSchema.shape.limits,
  features: PlanSchema.shape.features
});

export const EventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  cameraId: z.string(),
  type: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  timestamp: z.string(),
  payload: z.record(z.any()).optional()
});

export const StreamSessionStatusSchema = z.enum(["requested", "issued", "active", "ended", "expired"]);

export const StreamSessionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  cameraId: z.string(),
  userId: z.string(),
  status: StreamSessionStatusSchema,
  token: z.string(),
  expiresAt: z.string(),
  issuedAt: z.string(),
  activatedAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
  endReason: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const LoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(4)
});

export const MeResponseSchema = z.object({
  user: UserSchema,
  memberships: z.array(MembershipSchema),
  activeTenant: TenantSchema.optional(),
  entitlements: EntitlementsSchema.optional()
});

export type Tenant = z.infer<typeof TenantSchema>;
export type User = z.infer<typeof UserSchema>;
export type Membership = z.infer<typeof MembershipSchema>;
export type Camera = z.infer<typeof CameraSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type Entitlements = z.infer<typeof EntitlementsSchema>;
export type Event = z.infer<typeof EventSchema>;
export type StreamSession = z.infer<typeof StreamSessionSchema>;
