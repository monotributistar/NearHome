import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  Badge,
  WorkspaceShell,
  SelectInput,
  type WorkspaceNavGroup
} from "@app/ui";
import {
  BellNotification,
  Camera,
  Group,
  HomeAlt,
  Internet,
  MediaImageList,
  Planimetry,
  Settings,
  User
} from "iconoir-react";
import { ADMIN_ROUTES, useSession, getTenantId, getImpersonateRole } from "../lib/admin.js";
import { ControlPanelPage } from "../pages/operations/ControlPanelPage.js";
import { MonitorPage } from "../pages/operations/MonitorPage.js";
import { DetectionNodesPage } from "../pages/operations/DetectionNodesPage.js";
import { RealtimePage } from "../pages/operations/RealtimePage.js";
import { ClientOverviewPage } from "../pages/resources/ClientOverviewPage.js";
import { FaceInvestigationsPage } from "../pages/resources/FaceInvestigationsPage.js";
import { CamerasPage } from "../pages/resources/CamerasPage.js";
import { CameraShow } from "../pages/resources/CameraShow.js";
import { FaceIdentityShow } from "../pages/resources/FaceIdentityShow.js";
import { NotificationsPage } from "../pages/resources/NotificationsPage.js";
import { TenantsPage } from "../pages/identity/TenantsPage.js";
import { UsersPage } from "../pages/identity/UsersPage.js";
import { MembershipsPage } from "../pages/identity/MembershipsPage.js";
import { CameraAssignmentsPage } from "../pages/identity/CameraAssignmentsPage.js";
import { PlansPage } from "../pages/commercial/PlansPage.js";
import { SubscriptionPage } from "../pages/commercial/SubscriptionPage.js";

function LegacyCameraDetailRedirect() {
  const { id } = useParams();
  if (!id) return <Navigate to={ADMIN_ROUTES.resources.cameras} replace />;
  return <Navigate to={ADMIN_ROUTES.resources.cameraDetail(id)} replace />;
}

export function Layout({ apiUrl }: { apiUrl: string }) {
  const { loading, me, refresh } = useSession(apiUrl);
  const navigate = useNavigate();

  if (loading) return <div className="p-6">Loading...</div>;
  if (!me) return <Navigate to="/login" replace />;

  const activeTenant = getTenantId();
  const persistedImpersonationRole = getImpersonateRole();
  const role =
    me?.context?.effectiveRole ??
    (me?.user?.isSuperuser ? (persistedImpersonationRole ?? "super_admin") : me.memberships?.find((m: any) => m.tenantId === activeTenant)?.role);
  const isClientRole = role === "client_user";
  const navigation: WorkspaceNavGroup[] = isClientRole
    ? [
        {
          title: "Seguimiento",
          items: [
            { to: ADMIN_ROUTES.resources.clientOverview, label: "Resumen Cliente", icon: <HomeAlt width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.faceCases, label: "Identidades", icon: <User width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.cameras, label: "Cámaras", icon: <Camera width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.notifications, label: "Notificaciones", icon: <BellNotification width={16} height={16} /> }
          ]
        }
      ]
    : [
        {
          title: "Operaciones",
          items: [
            { to: ADMIN_ROUTES.operations.control, label: "Control Operativo", icon: <HomeAlt width={16} height={16} /> },
            { to: ADMIN_ROUTES.operations.monitor, label: "Monitor", icon: <MediaImageList width={16} height={16} /> },
            { to: ADMIN_ROUTES.operations.realtime, label: "Tiempo Real", icon: <Internet width={16} height={16} /> },
            { to: ADMIN_ROUTES.operations.nodes, label: "Nodos", icon: <Settings width={16} height={16} /> }
          ]
        },
        {
          title: "Recursos",
          items: [
            { to: ADMIN_ROUTES.resources.clientOverview, label: "Resumen Cliente", icon: <HomeAlt width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.faceCases, label: "Identidades", icon: <User width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.cameras, label: "Cámaras", icon: <Camera width={16} height={16} /> },
            { to: ADMIN_ROUTES.resources.notifications, label: "Notificaciones", icon: <BellNotification width={16} height={16} /> }
          ]
        },
        {
          title: "Identidad y Acceso",
          items: [
            { to: ADMIN_ROUTES.identity.tenants, label: "Tenants", icon: <Group width={16} height={16} /> },
            { to: ADMIN_ROUTES.identity.users, label: "Usuarios", icon: <User width={16} height={16} /> },
            { to: ADMIN_ROUTES.identity.memberships, label: "Membresías", icon: <Group width={16} height={16} /> },
            { to: ADMIN_ROUTES.identity.cameraAssignments, label: "Scope Cámaras", icon: <Camera width={16} height={16} /> }
          ]
        },
        {
          title: "Comercial",
          items: [
            { to: ADMIN_ROUTES.commercial.plans, label: "Planes", icon: <Planimetry width={16} height={16} /> },
            { to: ADMIN_ROUTES.commercial.subscriptions, label: "Suscripciones", icon: <Planimetry width={16} height={16} /> }
          ]
        }
      ];

  return (
    <WorkspaceShell
      product="NearHome Backoffice"
      subtitle="Panel operativo para administradores y operadores"
      role={<Badge data-testid="current-role">{role ?? "no-role"}</Badge>}
      tenantSwitcher={
        <div className="flex items-center gap-2">
          <SelectInput
            className="w-[220px]"
            value={activeTenant ?? ""}
            onChange={(e) => {
              localStorage.setItem("nearhome_active_tenant", e.target.value);
              refresh();
            }}
          >
            {me.memberships?.map((m: any) => (
              <option key={m.tenantId} value={m.tenantId}>
                {m.tenant.name}
              </option>
            ))}
          </SelectInput>
          {me?.user?.isSuperuser ? (
            <SelectInput
              className="w-[190px]"
              value={persistedImpersonationRole ?? "super_admin"}
              onChange={(e) => {
                const selectedRole = e.target.value;
                if (selectedRole === "super_admin") {
                  localStorage.removeItem("nearhome_impersonate_role");
                } else {
                  localStorage.setItem("nearhome_impersonate_role", selectedRole);
                }
                refresh();
              }}
            >
              <option value="super_admin">super_admin</option>
              <option value="tenant_admin">tenant_admin</option>
              <option value="monitor">monitor</option>
              <option value="client_user">client_user</option>
            </SelectInput>
          ) : null}
        </div>
      }
      onLogout={() => {
        localStorage.removeItem("nearhome_access_token");
        localStorage.removeItem("nearhome_active_tenant");
        localStorage.removeItem("nearhome_impersonate_role");
        navigate("/login");
      }}
      navigation={navigation}
    >
      <Routes>
        <Route path="/" element={<Navigate to={isClientRole ? ADMIN_ROUTES.resources.clientOverview : ADMIN_ROUTES.operations.control} replace />} />

        <Route path={ADMIN_ROUTES.operations.control} element={<ControlPanelPage apiUrl={apiUrl} />} />
        <Route path={ADMIN_ROUTES.operations.monitor} element={<MonitorPage apiUrl={apiUrl} />} />
        <Route path={ADMIN_ROUTES.operations.nodes} element={<DetectionNodesPage apiUrl={apiUrl} />} />
        <Route path={ADMIN_ROUTES.operations.realtime} element={<RealtimePage apiUrl={apiUrl} />} />

        <Route path={ADMIN_ROUTES.resources.clientOverview} element={<ClientOverviewPage apiUrl={apiUrl} />} />
        <Route path={ADMIN_ROUTES.resources.faceCases} element={<FaceInvestigationsPage apiUrl={apiUrl} />} />
        <Route path={ADMIN_ROUTES.resources.cameras} element={<CamerasPage />} />
        <Route path="/resources/cameras/:id" element={<CameraShow />} />
        <Route path="/resources/faces/:id" element={<FaceIdentityShow />} />
        <Route path={ADMIN_ROUTES.resources.notifications} element={<NotificationsPage apiUrl={apiUrl} />} />

        <Route path={ADMIN_ROUTES.identity.tenants} element={<TenantsPage />} />
        <Route path={ADMIN_ROUTES.identity.users} element={<UsersPage />} />
        <Route path={ADMIN_ROUTES.identity.memberships} element={<MembershipsPage />} />
        <Route path={ADMIN_ROUTES.identity.cameraAssignments} element={<CameraAssignmentsPage apiUrl={apiUrl} />} />

        <Route path={ADMIN_ROUTES.commercial.plans} element={<PlansPage />} />
        <Route path={ADMIN_ROUTES.commercial.subscriptions} element={<SubscriptionPage apiUrl={apiUrl} onChanged={refresh} />} />

        <Route path="/control" element={<Navigate to={ADMIN_ROUTES.operations.control} replace />} />
        <Route path="/monitor" element={<Navigate to={ADMIN_ROUTES.operations.monitor} replace />} />
        <Route path="/nodes" element={<Navigate to={ADMIN_ROUTES.operations.nodes} replace />} />
        <Route path="/realtime" element={<Navigate to={ADMIN_ROUTES.operations.realtime} replace />} />
        <Route path="/client-overview" element={<Navigate to={ADMIN_ROUTES.resources.clientOverview} replace />} />
        <Route path="/faces" element={<Navigate to={ADMIN_ROUTES.resources.faceCases} replace />} />
        <Route path="/cameras" element={<Navigate to={ADMIN_ROUTES.resources.cameras} replace />} />
        <Route path="/cameras/:id" element={<LegacyCameraDetailRedirect />} />
        <Route path="/notifications" element={<Navigate to={ADMIN_ROUTES.resources.notifications} replace />} />
        <Route path="/tenants" element={<Navigate to={ADMIN_ROUTES.identity.tenants} replace />} />
        <Route path="/users" element={<Navigate to={ADMIN_ROUTES.identity.users} replace />} />
        <Route path="/memberships" element={<Navigate to={ADMIN_ROUTES.identity.memberships} replace />} />
        <Route path="/camera-assignments" element={<Navigate to={ADMIN_ROUTES.identity.cameraAssignments} replace />} />
        <Route path="/plans" element={<Navigate to={ADMIN_ROUTES.commercial.plans} replace />} />
        <Route path="/subscriptions" element={<Navigate to={ADMIN_ROUTES.commercial.subscriptions} replace />} />
      </Routes>
    </WorkspaceShell>
  );
}
