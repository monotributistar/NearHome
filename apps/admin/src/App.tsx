import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useCan, useDelete, useList, useUpdate, useCreate } from "@refinedev/core";
import { AppShell, PageCard, PrimaryButton, TextInput, SelectInput, DangerButton, Badge } from "@app/ui";
import Hls from "hls.js";

type AppProps = { apiUrl: string };
const EVENT_GATEWAY_URL = import.meta.env.VITE_EVENT_GATEWAY_URL ?? "http://localhost:3011";

type RealtimeEvent = {
  eventId: string;
  eventType: string;
  tenantId: string;
  occurredAt: string;
  sequence: number;
  payload: Record<string, unknown>;
};

type DeploymentServiceProbe = {
  name: string;
  target: string;
  ok: boolean;
  statusCode?: number | null;
  latencyMs?: number | null;
  error?: string | null;
};

type DeploymentNodeItem = {
  nodeId?: string;
  status?: "online" | "degraded" | "offline" | string;
  tenantId?: string | null;
  runtime?: string;
  endpoint?: string;
  maxConcurrent?: number;
  isDrained?: boolean;
  queueDepth?: number;
  resources?: Record<string, unknown>;
  contractVersion?: string;
  capabilities?: Array<{ taskTypes?: string[] }>;
  models?: string[];
};

type DeploymentStatusData = {
  generatedAt: string;
  overallOk: boolean;
  services: DeploymentServiceProbe[];
  nodes: {
    sourceOk: boolean;
    sourceError?: string | null;
    total: number;
    online: number;
    degraded: number;
    offline: number;
    drained: number;
    revokedEstimate: number;
    items: DeploymentNodeItem[];
  };
};

type CameraMonitorItem = {
  id: string;
  name: string;
  location?: string | null;
  isActive: boolean;
  lifecycleStatus?: string;
};

type CameraFeedEntry = {
  playbackUrl?: string;
  expiresAt?: string;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
};

type CameraStreamHealth = {
  status: "healthy" | "degraded" | "offline" | "unknown";
  message: string;
  liveEdgeLagMs?: number | null;
  checkedAt?: string | null;
};

function toPlaybackPublicUrl(rawPlaybackUrl: string) {
  const configuredPublicBase = import.meta.env.VITE_STREAM_GATEWAY_PUBLIC_URL?.trim();
  const fallbackPublicBase = `${window.location.protocol}//${window.location.hostname}:3010`;
  try {
    const url = new URL(rawPlaybackUrl);
    if (configuredPublicBase) {
      const publicBase = new URL(configuredPublicBase);
      url.protocol = publicBase.protocol;
      url.host = publicBase.host;
      return url.toString();
    }
    if (url.hostname === "stream-gateway") {
      const publicBase = new URL(fallbackPublicBase);
      url.protocol = publicBase.protocol;
      url.host = publicBase.host;
    }
    return url.toString();
  } catch {
    return rawPlaybackUrl;
  }
}

function getStreamGatewayPublicBaseUrl() {
  const configuredPublicBase = import.meta.env.VITE_STREAM_GATEWAY_PUBLIC_URL?.trim();
  return configuredPublicBase || `${window.location.protocol}//${window.location.hostname}:3010`;
}

function buildPlaybackUrl(args: { tenantId: string; cameraId: string; token: string }) {
  const base = new URL(getStreamGatewayPublicBaseUrl());
  base.pathname = `/playback/${encodeURIComponent(args.tenantId)}/${encodeURIComponent(args.cameraId)}/index.m3u8`;
  base.search = `token=${encodeURIComponent(args.token)}`;
  return base.toString();
}

function toWsUrl(httpUrl: string) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

function matchesTopics(eventType: string, topics: string[]) {
  if (!topics.length) return true;
  return topics.some((topic) => eventType === topic || eventType.startsWith(`${topic}.`));
}

function getToken() {
  return localStorage.getItem("nearhome_access_token");
}

function getTenantId() {
  return localStorage.getItem("nearhome_active_tenant");
}

function summarizeApiError(error: unknown, fallback: string) {
  const err = error as {
    message?: string;
    statusCode?: number;
    response?: { status?: number; data?: unknown };
    data?: unknown;
  };
  const status = err.response?.status ?? err.statusCode;
  const payload = (err.response?.data ?? err.data) as
    | { code?: unknown; message?: unknown; details?: unknown }
    | string
    | undefined;

  if (payload && typeof payload === "object") {
    const code = typeof payload.code === "string" ? payload.code : null;
    const message = typeof payload.message === "string" ? payload.message : null;
    const details =
      payload.details && typeof payload.details === "object"
        ? Object.entries(payload.details as Record<string, unknown>)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(", ")
        : null;
    const parts = [code, message, details].filter(Boolean) as string[];
    if (parts.length > 0) return status ? `[${status}] ${parts.join(" | ")}` : parts.join(" | ");
  }

  if (typeof payload === "string" && payload.trim().length > 0) {
    return status ? `[${status}] ${payload}` : payload;
  }
  if (err.message && err.message.trim().length > 0) {
    return status ? `[${status}] ${err.message}` : err.message;
  }
  return status ? `[${status}] ${fallback}` : fallback;
}

function useSession(apiUrl: string) {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<any>(null);
  const navigate = useNavigate();

  const refresh = async () => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      setMe(null);
      return;
    }

    try {
      const res = await fetch(`${apiUrl}/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(getTenantId() ? { "X-Tenant-Id": getTenantId()! } : {})
        }
      });
      if (!res.ok) {
        localStorage.removeItem("nearhome_access_token");
        localStorage.removeItem("nearhome_active_tenant");
        setMe(null);
        setLoading(false);
        navigate("/login");
        return;
      }

      const data = await res.json();
      localStorage.setItem("nearhome_me", JSON.stringify(data));
      if (!getTenantId() && data.memberships?.[0]?.tenantId) {
        localStorage.setItem("nearhome_active_tenant", data.memberships[0].tenantId);
      }
      setMe(data);
      setLoading(false);
    } catch {
      localStorage.removeItem("nearhome_access_token");
      localStorage.removeItem("nearhome_active_tenant");
      setMe(null);
      setLoading(false);
      navigate("/login");
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { loading, me, refresh };
}

function LoginPage({ apiUrl }: { apiUrl: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@nearhome.dev");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (!res.ok) {
      setError("Credenciales inválidas");
      return;
    }

    const data = await res.json();
    localStorage.setItem("nearhome_access_token", data.accessToken);
    navigate("/");
  }

  return (
    <AppShell>
      <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
        <PageCard title="NearHome Admin Login">
          <form className="space-y-3" onSubmit={onSubmit}>
            <label className="form-control">
              <span className="label-text">Email</span>
              <TextInput aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="form-control">
              <span className="label-text">Password</span>
              <TextInput aria-label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <div className="alert alert-error py-2 text-sm">{error}</div>}
            <PrimaryButton type="submit" className="w-full">
              Login
            </PrimaryButton>
          </form>
        </PageCard>
      </div>
    </AppShell>
  );
}

function Layout({ apiUrl }: { apiUrl: string }) {
  const { loading, me, refresh } = useSession(apiUrl);
  const location = useLocation();
  const navigate = useNavigate();

  if (loading) return <div className="p-6">Loading...</div>;
  if (!me) return <Navigate to="/login" replace />;

  const activeTenant = getTenantId();
  const role = me.memberships?.find((m: any) => m.tenantId === activeTenant)?.role;

  return (
    <AppShell>
      <div className="navbar bg-base-100 shadow-md">
        <div className="flex-1 px-4 font-bold">NearHome Admin</div>
        <div className="flex items-center gap-2 px-4">
          <Badge data-testid="current-role">{role ?? "no-role"}</Badge>
          <SelectInput
            className="select-sm"
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
          <button
            className="btn btn-sm"
            onClick={() => {
              localStorage.removeItem("nearhome_access_token");
              localStorage.removeItem("nearhome_active_tenant");
              navigate("/login");
            }}
          >
            Logout
          </button>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-12 gap-4 p-4">
        <aside className="col-span-12 rounded-box bg-base-100 p-3 shadow md:col-span-3 lg:col-span-2">
          <ul className="menu gap-1">
            {[
              ["/control", "Control"],
              ["/tenants", "Tenants"],
              ["/users", "Users"],
              ["/memberships", "Memberships"],
              ["/cameras", "Cameras"],
              ["/monitor", "Monitor"],
              ["/realtime", "Realtime"],
              ["/plans", "Plans"],
              ["/subscriptions", "Subscriptions"]
            ].map(([to, label]) => (
              <li key={to}>
                <Link className={location.pathname.startsWith(to) ? "active" : ""} to={to}>
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </aside>

        <main className="col-span-12 space-y-4 md:col-span-9 lg:col-span-10">
          <Routes>
            <Route path="/" element={<Navigate to="/control" replace />} />
            <Route path="/control" element={<ControlPanelPage apiUrl={apiUrl} />} />
            <Route path="/tenants" element={<TenantsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/memberships" element={<MembershipsPage />} />
            <Route path="/cameras" element={<CamerasPage />} />
            <Route path="/cameras/:id" element={<CameraShow />} />
            <Route path="/monitor" element={<MonitorPage apiUrl={apiUrl} />} />
            <Route path="/realtime" element={<RealtimePage apiUrl={apiUrl} />} />
            <Route path="/plans" element={<PlansPage />} />
            <Route path="/subscriptions" element={<SubscriptionPage apiUrl={apiUrl} onChanged={refresh} />} />
          </Routes>
        </main>
      </div>
    </AppShell>
  );
}

function ControlPanelPage({ apiUrl }: { apiUrl: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DeploymentStatusData | null>(null);

  async function refreshStatus() {
    const token = getToken();
    if (!token) {
      setError("Missing auth token");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/ops/deployment/status`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!res.ok) throw new Error(`deployment status ${res.status}`);
      const body = await res.json();
      setData(body.data as DeploymentStatusData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => {
      void refreshStatus();
    }, 15000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl]);

  if (loading && !data) return <PageCard title="Control Panel">Loading deployment status...</PageCard>;

  return (
    <div className="space-y-4">
      <PageCard title="Control Panel">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge className={data?.overallOk ? "badge-success" : "badge-error"}>
            overall: {data?.overallOk ? "ok" : "degraded"}
          </Badge>
          <span className="text-sm opacity-70">
            updated: {data?.generatedAt ? new Date(data.generatedAt).toLocaleString() : "-"}
          </span>
          <PrimaryButton className="btn-sm" type="button" onClick={() => void refreshStatus()}>
            Refresh
          </PrimaryButton>
        </div>
        {error && <div className="alert alert-error py-2 text-sm">{error}</div>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          <div className="rounded-box border border-base-300 p-3 text-sm">
            <div className="font-semibold">Services</div>
            <div>{data?.services.length ?? 0}</div>
          </div>
          <div className="rounded-box border border-base-300 p-3 text-sm">
            <div className="font-semibold">Nodes online</div>
            <div>{data?.nodes.online ?? 0}</div>
          </div>
          <div className="rounded-box border border-base-300 p-3 text-sm">
            <div className="font-semibold">Nodes degraded</div>
            <div>{data?.nodes.degraded ?? 0}</div>
          </div>
          <div className="rounded-box border border-base-300 p-3 text-sm">
            <div className="font-semibold">Nodes offline</div>
            <div>{data?.nodes.offline ?? 0}</div>
          </div>
          <div className="rounded-box border border-base-300 p-3 text-sm">
            <div className="font-semibold">Drained</div>
            <div>{data?.nodes.drained ?? 0}</div>
          </div>
        </div>
      </PageCard>

      <PageCard title="Service Status">
        <div className="overflow-x-auto">
          <table className="table table-zebra">
            <thead>
              <tr>
                <th>Service</th>
                <th>Target</th>
                <th>Status</th>
                <th>HTTP</th>
                <th>Latency</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {(data?.services ?? []).map((service) => (
                <tr key={service.name}>
                  <td>{service.name}</td>
                  <td className="text-xs">{service.target}</td>
                  <td>
                    <Badge className={service.ok ? "badge-success" : "badge-error"}>{service.ok ? "ok" : "down"}</Badge>
                  </td>
                  <td>{service.statusCode ?? "-"}</td>
                  <td>{service.latencyMs ?? "-"}</td>
                  <td className="text-xs">{service.error ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageCard>

      <PageCard title="Node Registry">
        {!data?.nodes.sourceOk && data?.nodes.sourceError && (
          <div className="alert alert-warning mb-3 py-2 text-sm">node source error: {data.nodes.sourceError}</div>
        )}
        <div className="mb-3 text-sm opacity-80">
          total: {data?.nodes.total ?? 0} | revoked estimate: {data?.nodes.revokedEstimate ?? 0}
        </div>
        <div className="overflow-x-auto">
          <table className="table table-zebra">
            <thead>
              <tr>
                <th>Node</th>
                <th>Status</th>
                <th>Tenant</th>
                <th>Runtime</th>
                <th>Endpoint</th>
                <th>Queue</th>
                <th>Max</th>
                <th>Drained</th>
                <th>Resources</th>
                <th>Capabilities</th>
                <th>Models</th>
                <th>Contract</th>
              </tr>
            </thead>
            <tbody>
              {(data?.nodes.items ?? []).map((node, idx) => (
                <tr key={node.nodeId ?? `node-${idx}`}>
                  <td>{node.nodeId ?? "-"}</td>
                  <td>
                    <Badge
                      className={
                        node.status === "online"
                          ? "badge-success"
                          : node.status === "degraded"
                            ? "badge-warning"
                            : "badge-error"
                      }
                    >
                      {node.status ?? "-"}
                    </Badge>
                  </td>
                  <td>{node.tenantId ?? "-"}</td>
                  <td>{node.runtime ?? "-"}</td>
                  <td className="text-xs">{node.endpoint ?? "-"}</td>
                  <td>{node.queueDepth ?? 0}</td>
                  <td>{node.maxConcurrent ?? 0}</td>
                  <td>{node.isDrained ? "yes" : "no"}</td>
                  <td className="text-xs">
                    {node.resources
                      ? Object.entries(node.resources)
                          .map(([key, value]) => `${key}:${String(value)}`)
                          .join(", ")
                      : "-"}
                  </td>
                  <td className="text-xs">
                    {(node.capabilities ?? [])
                      .flatMap((cap) => cap.taskTypes ?? [])
                      .join(", ") || "-"}
                  </td>
                  <td className="text-xs">{(node.models ?? []).join(", ") || "-"}</td>
                  <td className="text-xs">{node.contractVersion ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageCard>

      <PageCard title="Architecture Hierarchy">
        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <div className="rounded-box border border-base-300 p-3">
            <div className="mb-1 font-semibold">Control Plane</div>
            <div>API</div>
            <div>Admin UI / Portal UI</div>
          </div>
          <div className="rounded-box border border-base-300 p-3">
            <div className="mb-1 font-semibold">Data Plane</div>
            <div>Stream Gateway</div>
            <div>Vault local/remote</div>
          </div>
          <div className="rounded-box border border-base-300 p-3">
            <div className="mb-1 font-semibold">Event Plane</div>
            <div>Event Gateway</div>
            <div>Realtime SSE/WS</div>
          </div>
          <div className="rounded-box border border-base-300 p-3">
            <div className="mb-1 font-semibold">Detection Plane</div>
            <div>Inference Bridge</div>
            <div>Dispatcher + Temporal + Worker + Nodes</div>
          </div>
        </div>
      </PageCard>
    </div>
  );
}

function TenantsPage() {
  const tenantsList = useList({ resource: "tenants" } as any);
  const { result } = tenantsList;
  const { mutate: create } = useCreate();
  const { mutate: update } = useUpdate();
  const { mutate: remove } = useDelete();
  const [name, setName] = useState("");
  const canCreate = useCan({ resource: "tenants", action: "create" }).data?.can;
  const canEdit = useCan({ resource: "tenants", action: "edit" }).data?.can;
  const canDelete = useCan({ resource: "tenants", action: "delete" }).data?.can;
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const nextDrafts = Object.fromEntries((result?.data ?? []).map((t: any) => [t.id, t.name ?? ""]));
    setDrafts(nextDrafts);
  }, [result?.data]);

  return (
    <PageCard title="Tenants">
      {canCreate && (
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create(
              { resource: "tenants", values: { name } },
              {
                onSuccess: () => {
                  (tenantsList as any).query.refetch();
                }
              }
            );
            setName("");
          }}
        >
          <TextInput placeholder="Tenant name" value={name} onChange={(e) => setName(e.target.value)} />
          <PrimaryButton type="submit">Create</PrimaryButton>
        </form>
      )}
      <div className="overflow-x-auto">
        <table className="table table-zebra">
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              {(canEdit || canDelete) && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {(result?.data ?? []).map((t: any) => (
              <tr key={t.id}>
                <td>
                  {canEdit ? (
                    <TextInput
                      data-testid={`tenant-name-${t.id}`}
                      value={drafts[t.id] ?? ""}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                    />
                  ) : (
                    t.name
                  )}
                </td>
                <td>{new Date(t.createdAt).toLocaleString()}</td>
                {(canEdit || canDelete) && (
                  <td>
                    <div className="flex flex-wrap gap-2">
                      {canEdit && (
                        <PrimaryButton
                          data-testid={`tenant-save-${t.id}`}
                          className="btn-sm"
                          type="button"
                          onClick={() =>
                            update(
                              {
                                resource: "tenants",
                                id: t.id,
                                values: { name: drafts[t.id] ?? t.name }
                              },
                              {
                                onSuccess: () => {
                                  (tenantsList as any).query.refetch();
                                }
                              }
                            )
                          }
                        >
                          Save
                        </PrimaryButton>
                      )}
                      {canDelete && (
                        <button
                          data-testid={`tenant-delete-${t.id}`}
                          className="btn btn-sm btn-error"
                          type="button"
                          onClick={() =>
                            remove(
                              {
                                resource: "tenants",
                                id: t.id
                              },
                              {
                                onSuccess: () => {
                                  (tenantsList as any).query.refetch();
                                }
                              }
                            )
                          }
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageCard>
  );
}

function UsersPage() {
  const usersList = useList({ resource: "users" } as any);
  const result = usersList.result;
  const { mutate: create } = useCreate();
  const { mutate: update } = useUpdate();
  const canCreate = useCan({ resource: "users", action: "create" }).data?.can;
  const canEdit = useCan({ resource: "users", action: "edit" }).data?.can;

  const [form, setForm] = useState({ email: "", name: "", password: "demo1234", role: "client_user" });
  const [rowDrafts, setRowDrafts] = useState<Record<string, { name: string; role: string; isActive: boolean }>>({});

  useEffect(() => {
    const nextDrafts = Object.fromEntries(
      (result?.data ?? []).map((u: any) => [
        u.id,
        {
          name: u.name ?? "",
          role: u.role ?? "client_user",
          isActive: Boolean(u.isActive)
        }
      ])
    );
    setRowDrafts(nextDrafts);
  }, [result?.data]);

  const users = useMemo(() => result?.data ?? [], [result?.data]);

  return (
    <PageCard title="Users">
      {canCreate && (
        <form
          data-testid="users-create-form"
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            create(
              { resource: "users", values: form },
              {
                onSuccess: () => {
                  setForm({ email: "", name: "", password: "demo1234", role: "client_user" });
                  (usersList as any).query.refetch();
                }
              }
            );
          }}
        >
          <TextInput
            placeholder="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
          <TextInput
            placeholder="name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <TextInput
            placeholder="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          />
          <SelectInput value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            <option value="tenant_admin">tenant_admin</option>
            <option value="monitor">monitor</option>
            <option value="client_user">customer</option>
          </SelectInput>
          <PrimaryButton type="submit">Create</PrimaryButton>
        </form>
      )}

      <table className="table table-zebra">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Status</th>
            {canEdit && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {users.map((u: any) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>
                {canEdit ? (
                  <TextInput
                    data-testid={`users-name-${u.id}`}
                    value={rowDrafts[u.id]?.name ?? ""}
                    onChange={(e) =>
                      setRowDrafts((prev) => ({
                        ...prev,
                        [u.id]: { ...(prev[u.id] ?? { name: "", role: "client_user", isActive: true }), name: e.target.value }
                      }))
                    }
                  />
                ) : (
                  u.name
                )}
              </td>
              <td>
                {canEdit ? (
                  <SelectInput
                    data-testid={`users-role-${u.id}`}
                    value={rowDrafts[u.id]?.role ?? "client_user"}
                    onChange={(e) =>
                      setRowDrafts((prev) => ({
                        ...prev,
                        [u.id]: { ...(prev[u.id] ?? { name: "", role: "client_user", isActive: true }), role: e.target.value }
                      }))
                    }
                  >
                    <option value="tenant_admin">tenant_admin</option>
                    <option value="monitor">monitor</option>
                    <option value="client_user">customer</option>
                  </SelectInput>
                ) : (
                  u.role
                )}
              </td>
              <td>
                <Badge className={rowDrafts[u.id]?.isActive ? "badge-success" : "badge-neutral"}>
                  {rowDrafts[u.id]?.isActive ? "active" : "inactive"}
                </Badge>
              </td>
              {canEdit && (
                <td>
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton
                      data-testid={`users-save-${u.id}`}
                      className="btn-sm"
                      type="button"
                      onClick={() =>
                        update(
                          {
                            resource: "users",
                            id: u.id,
                            values: {
                              name: rowDrafts[u.id]?.name,
                              role: rowDrafts[u.id]?.role
                            }
                          },
                          {
                            onSuccess: () => {
                              (usersList as any).query.refetch();
                            }
                          }
                        )
                      }
                    >
                      Save
                    </PrimaryButton>
                    <button
                      data-testid={`users-toggle-${u.id}`}
                      className="btn btn-sm"
                      type="button"
                      onClick={() =>
                        update(
                          {
                            resource: "users",
                            id: u.id,
                            values: { isActive: !rowDrafts[u.id]?.isActive }
                          },
                          {
                            onSuccess: () => {
                              (usersList as any).query.refetch();
                            }
                          }
                        )
                      }
                    >
                      {rowDrafts[u.id]?.isActive ? "Disable" : "Enable"}
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </PageCard>
  );
}

function MembershipsPage() {
  const { result } = useList({ resource: "memberships" } as any);
  const { mutate } = useCreate();
  const canCreate = useCan({ resource: "memberships", action: "create" }).data?.can;
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("client_user");
  return (
    <PageCard title="Memberships">
      {canCreate && (
        <form
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            mutate({ resource: "memberships", values: { userId, role } });
            setUserId("");
          }}
        >
          <TextInput placeholder="userId" value={userId} onChange={(e) => setUserId(e.target.value)} />
          <SelectInput value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="tenant_admin">tenant_admin</option>
            <option value="monitor">monitor</option>
            <option value="client_user">customer</option>
          </SelectInput>
          <PrimaryButton type="submit">Assign role</PrimaryButton>
        </form>
      )}
      <table className="table table-zebra">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {(result?.data ?? []).map((m: any) => (
            <tr key={m.id}>
              <td>{m.user?.email ?? m.userId}</td>
              <td>{m.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </PageCard>
  );
}

function CamerasPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const canCreate = useCan({ resource: "cameras", action: "create" }).data?.can;
  const canDelete = useCan({ resource: "cameras", action: "delete" }).data?.can;
  const canEdit = useCan({ resource: "cameras", action: "edit" }).data?.can;

  const camerasList = useList({
    resource: "cameras",
    pagination: { currentPage: page, pageSize: 5, mode: "server" },
    filters: q ? [{ field: "name", operator: "contains", value: q }] : []
  } as any);
  const result = camerasList.result;

  const { mutateAsync: create } = useCreate();
  const { mutateAsync: update } = useUpdate();
  const { mutate: remove } = useDelete();

  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const totalPages = Math.max(Math.ceil((result?.total ?? 0) / 5), 1);

  const rows = useMemo(() => result?.data ?? [], [result?.data]);

  return (
    <PageCard title="Cameras">
      <div className="mb-3 flex flex-wrap gap-2">
        <TextInput placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <PrimaryButton onClick={() => (camerasList as any).query.refetch()}>Search</PrimaryButton>
      </div>

      {(canCreate || canEdit) && (
        <form
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-12"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaveError(null);
            setSaveOk(null);
            const payload = { ...form, tags: form.tags ? form.tags.split(",").map((x) => x.trim()) : [] };
            try {
              setSaving(true);
              if (editing) {
                await update({ resource: "cameras", id: editing.id, values: payload });
                setEditing(null);
                setSaveOk("Camera actualizada");
              } else if (canCreate) {
                await create({ resource: "cameras", values: payload });
                setSaveOk("Camera creada");
              }
              setForm({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
              await (camerasList as any).query.refetch();
            } catch (error) {
              setSaveError(summarizeApiError(error, "No se pudo guardar la cámara"));
            } finally {
              setSaving(false);
            }
          }}
        >
          <TextInput
            placeholder="name"
            value={form.name}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <textarea
            placeholder="description"
            className="textarea textarea-bordered w-full md:col-span-3"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <TextInput
            placeholder="rtsp://usuario:password@ip:puerto/stream"
            value={form.rtspUrl}
            className="font-mono md:col-span-5"
            title={form.rtspUrl}
            onChange={(e) => setForm((f) => ({ ...f, rtspUrl: e.target.value }))}
          />
          <TextInput
            placeholder="location"
            value={form.location}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
          />
          <TextInput
            placeholder="tags csv"
            value={form.tags}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
          />
          <SelectInput
            value={String(form.isActive)}
            className="md:col-span-2"
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === "true" }))}
          >
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectInput>
          <PrimaryButton
            type="submit"
            className="md:col-span-2"
            disabled={saving || (editing ? !canEdit : !canCreate)}
          >
            {editing ? "Guardar cambios" : "Crear cámara"}
          </PrimaryButton>
          {editing && (
            <button
              type="button"
              className="btn btn-ghost md:col-span-2"
              onClick={() => {
                setEditing(null);
                setForm({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
                setSaveError(null);
              }}
            >
              Cancelar edición
            </button>
          )}
          {editing && (
            <div className="alert py-2 text-sm md:col-span-12">
              Editando cámara: <strong>{editing.name}</strong> ({editing.id})
            </div>
          )}
          {saveError && <div className="alert alert-error py-2 text-sm md:col-span-12">{saveError}</div>}
          {saveOk && <div className="alert alert-success py-2 text-sm md:col-span-12">{saveOk}</div>}
        </form>
      )}

      <table className="table table-zebra">
        <thead>
          <tr>
            <th>Name</th>
            <th>Location</th>
            <th>RTSP URL</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c: any) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.location || "-"}</td>
              <td>
                <code className="block max-w-[22rem] overflow-x-auto whitespace-nowrap text-xs">{c.rtspUrl}</code>
              </td>
              <td>
                <Badge className={c.isActive ? "badge-success" : "badge-ghost"}>
                  {c.isActive ? "Active" : "Inactive"}
                </Badge>
              </td>
              <td className="flex gap-2">
                <Link className="btn btn-xs" to={`/cameras/${c.id}`}>
                  Show
                </Link>
                {canEdit && (
                  <button
                    className="btn btn-xs"
                    onClick={() => {
                      setEditing(c);
                      setSaveError(null);
                      setSaveOk(null);
                      setForm({
                        name: c.name,
                        description: c.description ?? "",
                        rtspUrl: c.rtspUrl,
                        location: c.location ?? "",
                        tags: (c.tags ?? []).join(","),
                        isActive: c.isActive
                      });
                    }}
                  >
                    Edit
                  </button>
                )}
                {canDelete && (
                  <DangerButton
                    className="btn-xs"
                    onClick={() => {
                      remove({ resource: "cameras", id: c.id });
                      (camerasList as any).query.refetch();
                    }}
                  >
                    Delete
                  </DangerButton>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Prev
        </button>
        <span className="text-sm">
          Page {page} / {totalPages}
        </span>
        <button
          className="btn btn-sm"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        >
          Next
        </button>
      </div>
    </PageCard>
  );
}

function CameraShow() {
  const { id } = useParams();
  const canEdit = useCan({ resource: "cameras", action: "edit" }).data?.can;
  const [camera, setCamera] = useState<any>(null);
  const [loadingCamera, setLoadingCamera] = useState(true);
  const [profile, setProfile] = useState<any>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [profileSaved, setProfileSaved] = useState(false);
  const [lifecycle, setLifecycle] = useState<any>(null);
  const [loadingLifecycle, setLoadingLifecycle] = useState(true);
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);

  async function loadCamera() {
    const cameraId = id;
    if (!cameraId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) return;
    setLoadingCamera(true);
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${cameraId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      }
    });
    if (res.ok) {
      const body = await res.json();
      setCamera(body.data);
    }
    setLoadingCamera(false);
  }

  async function loadLifecycle() {
    const cameraId = id;
    if (!cameraId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) return;
    setLoadingLifecycle(true);
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${cameraId}/lifecycle`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      }
    });
    if (res.ok) {
      const body = await res.json();
      setLifecycle(body.data);
    }
    setLoadingLifecycle(false);
  }

  useEffect(() => {
    loadCamera();
    loadLifecycle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const cameraId = id;
    if (!cameraId) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) return;

    const loadProfile = async () => {
      setLoadingProfile(true);
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${cameraId}/profile`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        }
      });
      if (res.ok) {
        const body = await res.json();
        setProfile(body.data);
      }
      setLoadingProfile(false);
    };

    loadProfile();
  }, [id]);

  if (loadingCamera || !camera) return <div className="p-4">Loading...</div>;

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    if (!id || !profile) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) return;

    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${id}/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      },
      body: JSON.stringify({
        proxyPath: profile.proxyPath,
        recordingEnabled: profile.recordingEnabled,
        recordingStorageKey: profile.recordingStorageKey,
        detectorConfigKey: profile.detectorConfigKey,
        detectorResultsKey: profile.detectorResultsKey,
        detectorFlags: profile.detectorFlags,
        status: profile.status,
        lastHealthAt: profile.lastHealthAt ?? null,
        lastError: profile.lastError ?? null
      })
    });

    if (res.ok) {
      const body = await res.json();
      setProfile(body.data);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 1200);
    }
  }

  async function lifecycleAction(action: "validate" | "retire" | "reactivate", payload?: unknown) {
    if (!id) return;
    const token = getToken();
    const tenantId = getTenantId();
    if (!token || !tenantId) return;

    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/cameras/${id}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Tenant-Id": tenantId
      },
      body: payload ? JSON.stringify(payload) : "{}"
    });

    if (res.ok) {
      setLifecycleMessage(`${action} executed`);
      setTimeout(() => setLifecycleMessage(null), 1200);
      await Promise.all([loadCamera(), loadLifecycle()]);
    }
  }

  return (
    <PageCard title={`Camera: ${camera.name}`}>
      <div className="space-y-2">
        <div>Description: {camera.description ?? "-"}</div>
        <div>RTSP: {camera.rtspUrl}</div>
        <div>Location: {camera.location ?? "-"}</div>
        <div>Tags: {(camera.tags ?? []).join(", ")}</div>
        <div>
          Lifecycle:
          <Badge className="ml-2 badge-info" data-testid="camera-lifecycle-status">
            {camera.lifecycleStatus}
          </Badge>
        </div>
        <div>Created: {new Date(camera.createdAt).toLocaleString()}</div>
      </div>

      <div className="divider">Lifecycle</div>
      {loadingLifecycle && <div className="text-sm opacity-70">Loading lifecycle...</div>}
      {!loadingLifecycle && lifecycle && (
        <div className="space-y-3">
          <div className="rounded-box border border-base-300 p-3 text-sm">
            <div>Status: {lifecycle.currentStatus}</div>
            <div>Last transition: {lifecycle.lastTransitionAt ? new Date(lifecycle.lastTransitionAt).toLocaleString() : "-"}</div>
            <div>Last seen: {lifecycle.lastSeenAt ? new Date(lifecycle.lastSeenAt).toLocaleString() : "-"}</div>
            <div>Connectivity: {lifecycle.healthSnapshot?.connectivity ?? "-"}</div>
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <PrimaryButton data-testid="lifecycle-validate" type="button" onClick={() => lifecycleAction("validate")}>
                Validate
              </PrimaryButton>
              <button
                className="btn"
                data-testid="lifecycle-retire"
                type="button"
                onClick={() => lifecycleAction("retire")}
              >
                Retire
              </button>
              <button
                className="btn"
                data-testid="lifecycle-reactivate"
                type="button"
                onClick={() => lifecycleAction("reactivate")}
              >
                Reactivate
              </button>
            </div>
          )}
          {lifecycleMessage && <div className="text-sm text-success">{lifecycleMessage}</div>}
          <div className="overflow-x-auto">
            <table className="table table-zebra table-sm">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>From</th>
                  <th>To</th>
                </tr>
              </thead>
              <tbody>
                {(lifecycle.history ?? []).slice(0, 8).map((entry: any) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td>{entry.event}</td>
                    <td>{entry.fromStatus ?? "-"}</td>
                    <td>{entry.toStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="divider">Internal Profile</div>
      {loadingProfile && <div className="text-sm opacity-70">Loading profile...</div>}
      {!loadingProfile && profile && (
        <form className="grid grid-cols-1 gap-2 md:grid-cols-2" onSubmit={saveProfile}>
          {(!profile.configComplete || profile.status !== "ready") && (
            <div className="alert alert-warning md:col-span-2" data-testid="profile-fallback-alert">
              <span>
                Fallback active: profile {profile.configComplete ? "not ready" : "incomplete"}.
                {profile.lastError ? ` ${profile.lastError}` : ""}
              </span>
            </div>
          )}
          <SelectInput
            data-testid="profile-status"
            value={profile.status ?? "pending"}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, status: e.target.value }))}
          >
            <option value="pending">pending</option>
            <option value="ready">ready</option>
            <option value="error">error</option>
          </SelectInput>
          <TextInput
            data-testid="profile-last-health-at"
            value={profile.lastHealthAt ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, lastHealthAt: e.target.value }))}
          />
          <TextInput
            data-testid="profile-proxy-path"
            value={profile.proxyPath ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, proxyPath: e.target.value }))}
          />
          <SelectInput
            data-testid="profile-recording-enabled"
            value={String(profile.recordingEnabled)}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, recordingEnabled: e.target.value === "true" }))}
          >
            <option value="true">Recording enabled</option>
            <option value="false">Recording disabled</option>
          </SelectInput>
          <TextInput
            data-testid="profile-recording-storage"
            value={profile.recordingStorageKey ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, recordingStorageKey: e.target.value }))}
          />
          <TextInput
            data-testid="profile-detector-config"
            value={profile.detectorConfigKey ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, detectorConfigKey: e.target.value }))}
          />
          <TextInput
            data-testid="profile-detector-results"
            value={profile.detectorResultsKey ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, detectorResultsKey: e.target.value }))}
          />
          <TextInput
            data-testid="profile-last-error"
            value={profile.lastError ?? ""}
            disabled={!canEdit}
            onChange={(e) => setProfile((prev: any) => ({ ...prev, lastError: e.target.value }))}
          />
          <div className="flex flex-wrap items-center gap-3 rounded-box border border-base-300 p-3">
            {(["mediapipe", "yolo", "lpr"] as const).map((flag) => (
              <label key={flag} className="label cursor-pointer gap-2">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm"
                  checked={Boolean(profile.detectorFlags?.[flag])}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setProfile((prev: any) => ({
                      ...prev,
                      detectorFlags: { ...(prev.detectorFlags ?? {}), [flag]: e.target.checked }
                    }))
                  }
                />
                <span className="label-text">{flag}</span>
              </label>
            ))}
          </div>
          {canEdit && (
            <PrimaryButton data-testid="profile-save" type="submit" className="md:col-span-2">
              Save internal profile
            </PrimaryButton>
          )}
          {profileSaved && <div className="text-sm text-success md:col-span-2">Profile saved</div>}
        </form>
      )}
    </PageCard>
  );
}

function PlansPage() {
  const { result } = useList({ resource: "plans" } as any);
  return (
    <PageCard title="Plans">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(result?.data ?? []).map((p: any) => (
          <div key={p.id} className="rounded-box border border-base-300 p-4">
            <h3 className="text-lg font-bold">{p.name}</h3>
            <p className="text-sm opacity-70">{p.code}</p>
            <div className="mt-2 text-sm">Max cameras: {p.limits.maxCameras}</div>
            <div className="text-sm">Retention days: {p.limits.retentionDays}</div>
            <div className="mt-2 text-sm">
              Features:{" "}
              {Object.keys(p.features)
                .filter((f) => p.features[f])
                .join(", ")}
            </div>
          </div>
        ))}
      </div>
    </PageCard>
  );
}

function SubscriptionPage({ apiUrl, onChanged }: { apiUrl: string; onChanged: () => void }) {
  const { result: subscription } = useList({ resource: "subscriptions" } as any);
  const { result: plans } = useList({ resource: "plans" } as any);
  const canEdit = useCan({ resource: "subscriptions", action: "edit" }).data?.can;

  async function activate(planId: string) {
    const tenantId = getTenantId();
    if (!tenantId) return;
    await fetch(`${apiUrl}/tenants/${tenantId}/subscription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
        "X-Tenant-Id": tenantId
      },
      body: JSON.stringify({ planId })
    });
    onChanged();
    window.location.reload();
  }

  const active = subscription?.data?.[0] as any;

  return (
    <PageCard title="Subscription">
      {active ? (
        <div className="mb-4 rounded-box border border-base-300 p-4">
          <div>Current plan: {active.plan?.name}</div>
          <div>Status: {active.status}</div>
          <div>Period end: {new Date(active.currentPeriodEnd).toLocaleDateString()}</div>
        </div>
      ) : (
        <div className="mb-4 alert">No active subscription</div>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {(plans?.data ?? []).map((p: any) => (
            <button key={p.id} className="btn" onClick={() => activate(p.id)}>
              Activate {p.name}
            </button>
          ))}
        </div>
      )}
    </PageCard>
  );
}

function CameraFeedPlayer({ playbackUrl, cameraName }: { playbackUrl: string; cameraName: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;
    video.playsInline = true;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = playbackUrl;
      void video.play().catch(() => undefined);
      const keepNearLiveEdge = () => {
        const seekable = video.seekable;
        if (!seekable || seekable.length === 0) return;
        const liveEdge = seekable.end(seekable.length - 1);
        const lag = liveEdge - video.currentTime;
        if (lag > 1.2) {
          video.currentTime = Math.max(0, liveEdge - 0.15);
        }
      };
      const timer = window.setInterval(keepNearLiveEdge, 500);
      return () => {
        window.clearInterval(timer);
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) return;

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 2,
      maxBufferLength: 1,
      maxMaxBufferLength: 2,
      backBufferLength: 0,
      maxBufferSize: 0,
      highBufferWatchdogPeriod: 0.5
    });
    hlsRef.current = hls;
    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      hls.loadSource(playbackUrl);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void video.play().catch(() => undefined);
    });
    const liveEdgeTimer = window.setInterval(() => {
      const liveSyncPosition = hls.liveSyncPosition;
      if (typeof liveSyncPosition !== "number") return;
      if (liveSyncPosition - video.currentTime > 1.2) {
        video.currentTime = Math.max(0, liveSyncPosition - 0.1);
      }
    }, 500);

    return () => {
      window.clearInterval(liveEdgeTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [playbackUrl]);

  return <video ref={videoRef} className="aspect-video w-full rounded-box bg-black" controls autoPlay playsInline title={cameraName} />;
}

function MonitorPage({ apiUrl }: { apiUrl: string }) {
  const canList = useCan({ resource: "cameras", action: "list" }).data?.can;
  const [loading, setLoading] = useState(true);
  const [refreshingFeeds, setRefreshingFeeds] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const [cameras, setCameras] = useState<CameraMonitorItem[]>([]);
  const [feeds, setFeeds] = useState<Record<string, CameraFeedEntry>>({});
  const [streamHealth, setStreamHealth] = useState<Record<string, CameraStreamHealth>>({});

  const tenantId = getTenantId();
  const token = getToken();

  const visibleCameras = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cameras.filter((camera) => {
      if (onlyActive && !camera.isActive) return false;
      if (!q) return true;
      return (
        camera.name.toLowerCase().includes(q) ||
        String(camera.location ?? "")
          .toLowerCase()
          .includes(q) ||
        camera.id.toLowerCase().includes(q)
      );
    });
  }, [cameras, query, onlyActive]);

  async function loadAllCameras() {
    if (!token || !tenantId) {
      setError("Missing auth context");
      setLoading(false);
      return [];
    }

    const pageSize = 50;
    let start = 0;
    let total = Number.MAX_SAFE_INTEGER;
    const all: CameraMonitorItem[] = [];

    while (start < total) {
      const res = await fetch(`${apiUrl}/cameras?_start=${start}&_end=${start + pageSize}&_sort=createdAt&_order=DESC`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tenant-Id": tenantId
        }
      });
      if (!res.ok) throw new Error(`cameras ${res.status}`);
      const payload = (await res.json()) as { data?: CameraMonitorItem[]; total?: number };
      const rows = payload.data ?? [];
      const parsedTotal = Number(payload.total ?? res.headers.get("x-total-count") ?? rows.length);
      total = Number.isFinite(parsedTotal) ? parsedTotal : rows.length;
      all.push(...rows);
      if (rows.length === 0) break;
      start += rows.length;
    }

    setCameras(all);
    return all;
  }

  async function issueFeedTokens(targetCameras: CameraMonitorItem[], opts?: { force?: boolean }) {
    if (!token || !tenantId) return;
    if (!targetCameras.length) {
      setFeeds({});
      return;
    }

    setRefreshingFeeds(true);
    const force = Boolean(opts?.force);
    const now = Date.now();
    const validThresholdMs = 45 * 1000;
    const targets = targetCameras.filter((camera) => {
      if (force) return true;
      const current = feeds[camera.id];
      if (!current?.playbackUrl || current.status !== "ready" || !current.expiresAt) return true;
      const expiresAtMs = Date.parse(current.expiresAt);
      if (Number.isNaN(expiresAtMs)) return true;
      return expiresAtMs - now <= validThresholdMs;
    });

    if (!targets.length) {
      setRefreshingFeeds(false);
      return;
    }

    setFeeds((prev) => {
      const next = { ...prev };
      for (const camera of targets) {
        next[camera.id] = { ...(next[camera.id] ?? { status: "idle" }), status: "loading", error: undefined };
      }
      return next;
    });

    const nextEntries: Record<string, CameraFeedEntry> = {};
    let reusableSessionsByCamera: Record<string, { token: string; expiresAt: string }> | null = null;
    const loadReusableSessions = async () => {
      if (reusableSessionsByCamera) return reusableSessionsByCamera;
      const statuses = ["issued", "active"];
      const map: Record<string, { token: string; expiresAt: string }> = {};
      for (const status of statuses) {
        const sessionsResponse = await fetch(
          `${apiUrl}/stream-sessions?_start=0&_end=200&_sort=createdAt&_order=DESC&status=${status}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Tenant-Id": tenantId
            }
          }
        );
        if (!sessionsResponse.ok) continue;
        const payload = (await sessionsResponse.json()) as {
          data?: Array<{ cameraId?: string; token?: string; expiresAt?: string }>;
        };
        for (const session of payload.data ?? []) {
          if (!session.cameraId || !session.token || !session.expiresAt) continue;
          const expiresAtMs = Date.parse(session.expiresAt);
          if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) continue;
          if (!map[session.cameraId]) {
            map[session.cameraId] = {
              token: session.token,
              expiresAt: session.expiresAt
            };
          }
        }
      }
      reusableSessionsByCamera = map;
      return map;
    };

    for (const camera of targets) {
      try {
        const response = await fetch(`${apiUrl}/cameras/${camera.id}/stream-token`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Tenant-Id": tenantId
          }
        });
        if (response.status === 409) {
          const reusable = await loadReusableSessions();
          const reusableSession = reusable[camera.id];
          if (reusableSession) {
            nextEntries[camera.id] = {
              status: "ready",
              playbackUrl: buildPlaybackUrl({
                tenantId,
                cameraId: camera.id,
                token: reusableSession.token
              }),
              expiresAt: reusableSession.expiresAt
            };
            continue;
          }
        }
        if (!response.ok) throw new Error(`stream-token ${response.status}`);
        const payload = (await response.json()) as { playbackUrl?: string; expiresAt?: string };
        if (!payload.playbackUrl) {
          nextEntries[camera.id] = { status: "error", error: "No playback URL returned" };
          continue;
        }
        nextEntries[camera.id] = {
          status: "ready",
          playbackUrl: toPlaybackPublicUrl(payload.playbackUrl),
          expiresAt: payload.expiresAt
        };
      } catch (tokenError) {
        const existing = feeds[camera.id];
        if (existing?.playbackUrl && existing.status === "ready") {
          nextEntries[camera.id] = existing;
          continue;
        }
        nextEntries[camera.id] = {
          status: "error",
          error: tokenError instanceof Error ? tokenError.message : "token error"
        };
      }
    }

    setFeeds((prev) => ({ ...prev, ...nextEntries }));
    setRefreshingFeeds(false);
  }

  async function refreshStreamHealth(targetCameras: CameraMonitorItem[]) {
    if (!tenantId || !targetCameras.length) return;
    const next: Record<string, CameraStreamHealth> = {};
    await Promise.all(
      targetCameras.map(async (camera) => {
        try {
          const playbackOrigin = (() => {
            const currentPlaybackUrl = feeds[camera.id]?.playbackUrl;
            if (!currentPlaybackUrl) return null;
            try {
              return new URL(currentPlaybackUrl).origin;
            } catch {
              return null;
            }
          })();
          const baseUrl = playbackOrigin ?? getStreamGatewayPublicBaseUrl();
          const response = await fetch(
            `${baseUrl}/health/${encodeURIComponent(tenantId)}/${encodeURIComponent(camera.id)}`
          );
          if (!response.ok) {
            next[camera.id] = {
              status: "offline",
              message: response.status === 404 ? "Stream no provisionado" : `Health ${response.status}`,
              checkedAt: new Date().toISOString()
            };
            return;
          }
          const payload = (await response.json()) as {
            data?: { status?: string; health?: { connectivity?: string; error?: string | null } };
            runtime?: {
              liveEdgeLagMs?: number | null;
              liveEdgeStale?: boolean | null;
              workerState?: string | null;
              workerLastExitCode?: number | null;
              diagnostics?: string[];
            };
          };
          const diagnostics = payload.runtime?.diagnostics ?? [];
          const workerState = payload.runtime?.workerState ?? "unknown";
          const connectivity = payload.data?.health?.connectivity ?? "unknown";
          const liveEdgeLagMs = payload.runtime?.liveEdgeLagMs ?? null;
          let status: CameraStreamHealth["status"] = "healthy";
          if (payload.data?.status !== "ready" || workerState !== "running" || connectivity === "offline") {
            status = "offline";
          } else if (payload.runtime?.liveEdgeStale || connectivity === "degraded") {
            status = "degraded";
          }
          const baseMessage =
            status === "healthy"
              ? "Feed en tiempo real OK"
              : status === "degraded"
                ? "Feed con atraso o degradación"
                : "Feed caído o inestable";
          const suffix = diagnostics.length > 0 ? ` (${diagnostics.slice(0, 2).join(", ")})` : "";
          const exitSuffix =
            payload.runtime?.workerLastExitCode !== null && payload.runtime?.workerLastExitCode !== undefined
              ? ` [exit=${payload.runtime.workerLastExitCode}]`
              : "";
          next[camera.id] = {
            status,
            message: `${baseMessage}${suffix}${exitSuffix}`,
            liveEdgeLagMs,
            checkedAt: new Date().toISOString()
          };
        } catch (healthError) {
          next[camera.id] = {
            status: "unknown",
            message: healthError instanceof Error ? `Health endpoint unreachable: ${healthError.message}` : "Health check failed",
            checkedAt: new Date().toISOString()
          };
        }
      })
    );
    setStreamHealth((prev) => ({ ...prev, ...next }));
  }

  useEffect(() => {
    if (canList === false) {
      setLoading(false);
      return;
    }
    if (!token || !tenantId) {
      setLoading(false);
      setError("Missing auth context");
      return;
    }

    let canceled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const all = await loadAllCameras();
        if (canceled) return;
        await issueFeedTokens(all);
        await refreshStreamHealth(all);
      } catch (loadError) {
        if (canceled) return;
        setError(loadError instanceof Error ? loadError.message : "load error");
      } finally {
        if (!canceled) setLoading(false);
      }
    })();

    return () => {
      canceled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, canList, tenantId, token]);

  useEffect(() => {
    if (!cameras.length) return;
    const id = window.setInterval(() => {
      void issueFeedTokens(cameras);
      void refreshStreamHealth(cameras);
    }, 4 * 60 * 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, apiUrl, token, tenantId]);

  useEffect(() => {
    if (!cameras.length) return;
    const id = window.setInterval(() => {
      void refreshStreamHealth(cameras);
    }, 10_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, tenantId]);

  if (canList === false) return <PageCard title="Monitor">No tenés permisos para listar cámaras.</PageCard>;

  return (
    <PageCard title="Monitor de cámaras (tiempo real)">
      <div className="mb-3 flex flex-wrap gap-2">
        <TextInput
          className="max-w-sm"
          placeholder="Buscar por nombre, location o id"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="label cursor-pointer gap-2">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={onlyActive}
            onChange={(event) => setOnlyActive(event.target.checked)}
          />
          <span className="label-text">Solo activas</span>
        </label>
        <PrimaryButton
          className="btn-sm"
          type="button"
          onClick={() => {
            void issueFeedTokens(cameras, { force: true });
            void refreshStreamHealth(cameras);
          }}
        >
          Refrescar feeds
        </PrimaryButton>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge>{visibleCameras.length} visibles</Badge>
        <Badge>{cameras.length} totales</Badge>
        {refreshingFeeds && <Badge className="badge-warning">actualizando tokens</Badge>}
      </div>
      {error && <div className="alert alert-error mb-3 py-2 text-sm">{error}</div>}
      {loading && <div className="text-sm opacity-70">Cargando cámaras y sesiones...</div>}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
        {visibleCameras.map((camera) => {
          const feed = feeds[camera.id];
          const health = streamHealth[camera.id];
          return (
            <div key={camera.id} className="rounded-box border border-base-300 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">{camera.name}</div>
                <div className="flex items-center gap-1">
                  <Badge className={camera.isActive ? "badge-success" : "badge-ghost"}>
                    {camera.isActive ? "active" : "inactive"}
                  </Badge>
                  <Badge>{camera.lifecycleStatus ?? "unknown"}</Badge>
                </div>
              </div>
              <div className="mb-2 text-xs opacity-70">
                <div>id: {camera.id}</div>
                <div>location: {camera.location ?? "-"}</div>
                <div>token expira: {feed?.expiresAt ? new Date(feed.expiresAt).toLocaleTimeString() : "-"}</div>
                <div>
                  stream health:{" "}
                  {health ? (
                    <span>
                      {health.status}
                      {typeof health.liveEdgeLagMs === "number" ? ` · lag ${Math.round(health.liveEdgeLagMs)}ms` : ""}
                    </span>
                  ) : (
                    "loading"
                  )}
                </div>
                {health?.message && <div>diagnóstico: {health.message}</div>}
              </div>
              {feed?.status === "ready" && feed.playbackUrl ? (
                <CameraFeedPlayer playbackUrl={feed.playbackUrl} cameraName={camera.name} />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-box bg-base-200 text-sm">
                  {feed?.status === "loading" ? "Preparando stream..." : feed?.error ?? "Feed no disponible"}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!loading && !visibleCameras.length && <div className="mt-3 text-sm opacity-70">No hay cámaras para mostrar.</div>}
    </PageCard>
  );
}

function RealtimePage({ apiUrl }: { apiUrl: string }) {
  const [status, setStatus] = useState<"connecting" | "connected" | "degraded" | "disconnected">("disconnected");
  const [transport, setTransport] = useState<"ws" | "sse" | "none">("none");
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [topics, setTopics] = useState("incident,detection,stream");
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);
  const stopRef = useRef(false);
  const tenantId = getTenantId();
  const token = getToken();

  useEffect(() => {
    if (!tenantId || !token) {
      setStatus("disconnected");
      setTransport("none");
      return;
    }

    stopRef.current = false;
    let wsAttempts = 0;
    let sseAttempts = 0;
    const seenIds = new Set<string>();

    const schedule = (ms: number, fn: () => void) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(fn, ms);
    };

    const pushEvents = (batch: RealtimeEvent[]) => {
      const filtered = batch.filter((event) => {
        if (seenIds.has(event.eventId)) return false;
        seenIds.add(event.eventId);
        return true;
      });
      if (!filtered.length) return;
      setEvents((prev) => [...filtered, ...prev].slice(0, 50));
    };

    const selectedTopics = topics
      .split(",")
      .map((topic) => topic.trim())
      .filter(Boolean);

    const connectSse = async () => {
      if (stopRef.current) return;
      setTransport("sse");
      setStatus("degraded");
      try {
        const url = new URL("/events/stream", EVENT_GATEWAY_URL);
        url.searchParams.set("replay", "20");
        url.searchParams.set("once", "1");
        if (selectedTopics.length) {
          url.searchParams.set("topics", selectedTopics.join(","));
        }
        const response = await fetch(url.toString(), {
          headers: { "X-Tenant-Id": tenantId }
        });
        if (!response.ok) throw new Error(`sse ${response.status}`);
        const raw = await response.text();
        const chunks = raw.split("\n\n");
        const parsed: RealtimeEvent[] = [];
        for (const chunk of chunks) {
          const eventLine = chunk
            .split("\n")
            .find((line) => line.startsWith("event: "))
            ?.slice(7)
            .trim();
          const dataLine = chunk
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
            .trim();
          if (!eventLine || !dataLine) continue;
          const event = JSON.parse(dataLine) as RealtimeEvent;
          if (!matchesTopics(event.eventType, selectedTopics)) continue;
          parsed.push(event);
        }
        pushEvents(parsed);
        sseAttempts = 0;
        setStatus("connected");
        schedule(2000, connectSse);
      } catch {
        const delay = Math.min(15000, 1000 * 2 ** Math.min(sseAttempts, 4));
        sseAttempts += 1;
        setStatus("degraded");
        schedule(delay, connectSse);
      }
    };

    const connectWs = async () => {
      if (stopRef.current) return;
      setStatus("connecting");
      try {
        const tokenResponse = await fetch(`${apiUrl}/events/ws-token`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Tenant-Id": tenantId
          }
        });
        if (!tokenResponse.ok) throw new Error(`ws-token ${tokenResponse.status}`);
        const tokenData = (await tokenResponse.json()) as { data?: { token?: string } };
        const wsToken = tokenData.data?.token;
        if (!wsToken) throw new Error("missing ws token");
        const wsUrl = new URL(toWsUrl(EVENT_GATEWAY_URL));
        wsUrl.searchParams.set("token", wsToken);
        const ws = new WebSocket(wsUrl.toString());
        wsRef.current = ws;
        ws.onopen = () => {
          wsAttempts = 0;
          setTransport("ws");
          setStatus("connected");
        };
        ws.onmessage = (message) => {
          try {
            const event = JSON.parse(String(message.data)) as RealtimeEvent;
            if (!matchesTopics(event.eventType, selectedTopics)) return;
            pushEvents([event]);
          } catch {
            // ignore malformed payloads
          }
        };
        ws.onclose = () => {
          if (stopRef.current) return;
          const delay = Math.min(15000, 1000 * 2 ** Math.min(wsAttempts, 4));
          wsAttempts += 1;
          schedule(delay, connectWs);
        };
        ws.onerror = () => {
          if (stopRef.current) return;
          ws.close();
          connectSse().catch(() => undefined);
        };
      } catch {
        connectSse().catch(() => undefined);
      }
    };

    connectWs().catch(() => undefined);

    return () => {
      stopRef.current = true;
      wsRef.current?.close();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [apiUrl, tenantId, token, topics]);

  return (
    <PageCard title="Realtime stream">
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4">
        <TextInput
          value={topics}
          onChange={(event) => setTopics(event.target.value)}
          placeholder="topics csv (incident,detection,stream)"
        />
        <div className="rounded-box bg-base-200 px-3 py-2 text-sm">transport: {transport}</div>
        <div className="rounded-box bg-base-200 px-3 py-2 text-sm">tenant: {tenantId ?? "-"}</div>
        <div className="rounded-box bg-base-200 px-3 py-2 text-sm">status: {status}</div>
      </div>
      <div className="space-y-2">
        {events.map((event) => (
          <div key={event.eventId} className="rounded-box bg-base-200 p-3 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <Badge>{event.eventType}</Badge>
              <span>{new Date(event.occurredAt).toLocaleString()}</span>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(event.payload, null, 2)}</pre>
          </div>
        ))}
        {!events.length && <div className="text-sm opacity-70">No realtime events received yet.</div>}
      </div>
    </PageCard>
  );
}

export function App({ apiUrl }: AppProps) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage apiUrl={apiUrl} />} />
      <Route path="/*" element={<Layout apiUrl={apiUrl} />} />
    </Routes>
  );
}
