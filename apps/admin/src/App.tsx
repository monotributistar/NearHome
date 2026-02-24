import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useCan, useDelete, useList, useUpdate, useCreate } from "@refinedev/core";
import { AppShell, PageCard, PrimaryButton, TextInput, SelectInput, DangerButton, Badge } from "@app/ui";

type AppProps = { apiUrl: string };

function getToken() {
  return localStorage.getItem("nearhome_access_token");
}

function getTenantId() {
  return localStorage.getItem("nearhome_active_tenant");
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
          <Badge>{role ?? "no-role"}</Badge>
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
              ["/tenants", "Tenants"],
              ["/users", "Users"],
              ["/memberships", "Memberships"],
              ["/cameras", "Cameras"],
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
            <Route path="/" element={<Navigate to="/cameras" replace />} />
            <Route path="/tenants" element={<TenantsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/memberships" element={<MembershipsPage />} />
            <Route path="/cameras" element={<CamerasPage />} />
            <Route path="/cameras/:id" element={<CameraShow />} />
            <Route path="/plans" element={<PlansPage />} />
            <Route path="/subscriptions" element={<SubscriptionPage apiUrl={apiUrl} onChanged={refresh} />} />
          </Routes>
        </main>
      </div>
    </AppShell>
  );
}

function TenantsPage() {
  const { result } = useList({ resource: "tenants" } as any);
  const { mutate } = useCreate();
  const [name, setName] = useState("");
  const canCreate = useCan({ resource: "tenants", action: "create" }).data?.can;

  return (
    <PageCard title="Tenants">
      {canCreate && (
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            mutate({ resource: "tenants", values: { name } });
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
            </tr>
          </thead>
          <tbody>
            {(result?.data ?? []).map((t: any) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{new Date(t.createdAt).toLocaleString()}</td>
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
            <option value="client_user">client_user</option>
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
                    <option value="client_user">client_user</option>
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
            <option value="client_user">client_user</option>
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

  const { mutate: create } = useCreate();
  const { mutate: update } = useUpdate();
  const { mutate: remove } = useDelete();

  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });

  const totalPages = Math.max(Math.ceil((result?.total ?? 0) / 5), 1);

  const rows = useMemo(() => result?.data ?? [], [result?.data]);

  return (
    <PageCard title="Cameras">
      <div className="mb-3 flex flex-wrap gap-2">
        <TextInput placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <PrimaryButton onClick={() => (camerasList as any).query.refetch()}>Search</PrimaryButton>
      </div>

      {canCreate && (
        <form
          className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-7"
          onSubmit={(e) => {
            e.preventDefault();
            const payload = { ...form, tags: form.tags ? form.tags.split(",").map((x) => x.trim()) : [] };
            if (editing) {
              update({ resource: "cameras", id: editing.id, values: payload }, { onSuccess: () => setEditing(null) });
            } else {
              create({ resource: "cameras", values: payload });
            }
            setForm({ name: "", description: "", rtspUrl: "", location: "", tags: "", isActive: true });
            (camerasList as any).query.refetch();
          }}
        >
          <TextInput
            placeholder="name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <textarea
            placeholder="description"
            className="textarea textarea-bordered w-full"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <TextInput
            placeholder="rtsp://..."
            value={form.rtspUrl}
            onChange={(e) => setForm((f) => ({ ...f, rtspUrl: e.target.value }))}
          />
          <TextInput
            placeholder="location"
            value={form.location}
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
          />
          <TextInput
            placeholder="tags csv"
            value={form.tags}
            onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
          />
          <SelectInput
            value={String(form.isActive)}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === "true" }))}
          >
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectInput>
          <PrimaryButton type="submit">{editing ? "Save" : "Create"}</PrimaryButton>
        </form>
      )}

      <table className="table table-zebra">
        <thead>
          <tr>
            <th>Name</th>
            <th>Location</th>
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

export function App({ apiUrl }: AppProps) {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage apiUrl={apiUrl} />} />
      <Route path="/*" element={<Layout apiUrl={apiUrl} />} />
    </Routes>
  );
}
