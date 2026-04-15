import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { Camera, HomeAlt, Internet, UserCircle, ViewGrid, WarningSquare, Group, Medal } from "iconoir-react";
import { WorkspaceShell, SelectInput, type WorkspaceNavGroup } from "@app/ui";
import { usePortalClient, PORTAL_ROUTES } from "../lib/client.js";
import { CamerasPage } from "../pages/cameras/CamerasPage.js";
import { CameraDetailPage } from "../pages/cameras/CameraDetailPage.js";
import { EventsPage } from "../pages/events/EventsPage.js";
import { RealtimePage } from "../pages/realtime/RealtimePage.js";
import { HouseholdsPage } from "../pages/account/HouseholdsPage.js";
import { PlanPage } from "../pages/plan/PlanPage.js";
import { ProfilePage, SelectTenantPage } from "../pages/account/ProfilePage.js";
import { ViewersPage } from "../pages/viewers/ViewersPage.js";

function LegacyPortalCameraDetailRedirect() {
  const { id } = useParams();
  if (!id) return <Navigate to={PORTAL_ROUTES.operations.cameras} replace />;
  return <Navigate to={PORTAL_ROUTES.operations.cameraDetail(id)} replace />;
}

export function ProtectedLayout() {
  const { api, state, setSession } = usePortalClient();
  const [me, setMe] = useState<any>(null);

  useEffect(() => {
    if (!state.accessToken) return;
    api
      .get<any>("/auth/me")
      .then((res) => {
        setMe(res);
        if (!state.activeTenantId && res.memberships?.[0]?.tenantId) {
          setSession({ activeTenantId: res.memberships[0].tenantId });
        }
      })
      .catch(() => {
        setSession({ accessToken: null, activeTenantId: null });
      });
  }, [api, setSession, state.accessToken, state.activeTenantId]);

  if (!state.accessToken) return <Navigate to="/login" replace />;
  if (!me) return <div className="p-6">Loading...</div>;

  const role: string = me.effectiveRole ?? me.memberships?.[0]?.role ?? "client_user";
  const isMonitor = role === "monitor";
  const isTenantAdmin = role === "tenant_admin";
  const canManageViewers = isMonitor || isTenantAdmin;
  const canManagePlan = isMonitor;

  const navigation: WorkspaceNavGroup[] = [
    {
      title: "Operations",
      items: [
        { to: PORTAL_ROUTES.operations.cameras, label: "Cameras", icon: <Camera width={16} height={16} /> },
        { to: PORTAL_ROUTES.operations.events, label: "Events", icon: <WarningSquare width={16} height={16} /> },
        { to: PORTAL_ROUTES.operations.realtime, label: "Realtime", icon: <Internet width={16} height={16} /> }
      ]
    },
    {
      title: "Account",
      items: [
        ...(canManageViewers ? [{ to: PORTAL_ROUTES.viewers, label: "Viewers", icon: <Group width={16} height={16} /> }] : []),
        { to: PORTAL_ROUTES.account.households, label: "Households", icon: <HomeAlt width={16} height={16} /> },
        ...(canManagePlan ? [{ to: PORTAL_ROUTES.plan, label: "Plan", icon: <Medal width={16} height={16} /> }] : []),
        { to: PORTAL_ROUTES.account.tenant, label: "Active Place", icon: <ViewGrid width={16} height={16} /> },
        { to: PORTAL_ROUTES.account.profile, label: "Profile", icon: <UserCircle width={16} height={16} /> }
      ]
    }
  ];

  return (
    <WorkspaceShell
      product="NearHome"
      subtitle="Your home security portal"
      tenantSwitcher={
        <SelectInput
          className="w-[220px]"
          value={state.activeTenantId ?? ""}
          onChange={(e) => setSession({ activeTenantId: e.target.value })}
        >
          {me.memberships?.map((m: any) => (
            <option key={m.tenantId} value={m.tenantId}>
              {m.tenant.name}
            </option>
          ))}
        </SelectInput>
      }
      onLogout={() => setSession({ accessToken: null, activeTenantId: null })}
      navigation={navigation}
    >
      <Routes>
        <Route path="/" element={<Navigate to={PORTAL_ROUTES.operations.cameras} replace />} />

        <Route path={PORTAL_ROUTES.operations.cameras} element={<CamerasPage api={api} />} />
        <Route path="/operations/cameras/:id" element={<CameraDetailPage api={api} />} />
        <Route path={PORTAL_ROUTES.operations.events} element={<EventsPage api={api} />} />
        <Route path={PORTAL_ROUTES.operations.realtime} element={<RealtimePage api={api} tenantId={state.activeTenantId} />} />

        <Route path={PORTAL_ROUTES.account.households} element={<HouseholdsPage api={api} />} />
        <Route path={PORTAL_ROUTES.account.tenant} element={<SelectTenantPage me={me} />} />
        <Route path={PORTAL_ROUTES.account.profile} element={<ProfilePage me={me} />} />

        {canManageViewers && <Route path={PORTAL_ROUTES.viewers} element={<ViewersPage api={api} />} />}
        {canManagePlan && <Route path={PORTAL_ROUTES.plan} element={<PlanPage api={api} />} />}
        <Route path={PORTAL_ROUTES.account.subscriptions} element={<Navigate to={PORTAL_ROUTES.plan} replace />} />

        {/* Legacy redirects */}
        <Route path="/cameras" element={<Navigate to={PORTAL_ROUTES.operations.cameras} replace />} />
        <Route path="/cameras/:id" element={<LegacyPortalCameraDetailRedirect />} />
        <Route path="/events" element={<Navigate to={PORTAL_ROUTES.operations.events} replace />} />
        <Route path="/realtime" element={<Navigate to={PORTAL_ROUTES.operations.realtime} replace />} />
        <Route path="/households" element={<Navigate to={PORTAL_ROUTES.account.households} replace />} />
        <Route path="/subscriptions" element={<Navigate to={PORTAL_ROUTES.plan} replace />} />
        <Route path="/select-tenant" element={<Navigate to={PORTAL_ROUTES.account.tenant} replace />} />
        <Route path="/account" element={<Navigate to={PORTAL_ROUTES.account.profile} replace />} />
      </Routes>
    </WorkspaceShell>
  );
}
