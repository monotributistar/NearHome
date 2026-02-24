import { useEffect, useMemo, useState } from "react";
import { ApiClient, loadSessionState, saveSessionState } from "@app/api-client";
import { AppShell, PageCard, PrimaryButton, SelectInput, TextInput, Badge } from "@app/ui";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

function usePortalClient() {
  const [state, setState] = useState(loadSessionState());
  const navigate = useNavigate();

  const api = useMemo(
    () =>
      new ApiClient({
        baseUrl: API_URL,
        getToken: () => state.accessToken,
        getTenantId: () => state.activeTenantId,
        onUnauthorized: () => {
          saveSessionState({ accessToken: null, activeTenantId: null });
          setState({ accessToken: null, activeTenantId: null });
          navigate("/login");
        }
      }),
    [navigate, state.accessToken, state.activeTenantId]
  );

  const setSession = (next: Partial<typeof state>) => {
    saveSessionState(next);
    setState((prev) => ({ ...prev, ...next }));
  };

  return { api, state, setSession };
}

function LoginPage() {
  const { api, state, setSession } = usePortalClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("monitor@nearhome.dev");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState<string | null>(null);

  if (state.accessToken) return <Navigate to="/select-tenant" replace />;

  return (
    <AppShell>
      <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
        <PageCard title="Portal Login">
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const data = await api.post<any>("/auth/login", { email, password });
                setSession({ accessToken: data.accessToken });
                navigate("/select-tenant");
              } catch {
                setError("Credenciales inválidas");
              }
            }}
          >
            <label className="form-control">
              <span className="label-text">Email</span>
              <TextInput value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="form-control">
              <span className="label-text">Password</span>
              <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
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

function ProtectedLayout() {
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

  return (
    <AppShell>
      <div className="navbar bg-base-100 shadow">
        <div className="flex-1 px-4 font-bold">NearHome Portal</div>
        <div className="flex items-center gap-2 px-4">
          <SelectInput
            className="select-sm"
            value={state.activeTenantId ?? ""}
            onChange={(e) => setSession({ activeTenantId: e.target.value })}
          >
            {me.memberships?.map((m: any) => (
              <option key={m.tenantId} value={m.tenantId}>
                {m.tenant.name}
              </option>
            ))}
          </SelectInput>
          <button className="btn btn-sm" onClick={() => setSession({ accessToken: null, activeTenantId: null })}>
            Logout
          </button>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-12 gap-4 p-4">
        <aside className="col-span-12 rounded-box bg-base-100 p-3 shadow md:col-span-3 lg:col-span-2">
          <ul className="menu gap-1">
            <li>
              <Link to="/select-tenant">Select tenant</Link>
            </li>
            <li>
              <Link to="/cameras">Cameras</Link>
            </li>
            <li>
              <Link to="/events">Events</Link>
            </li>
            <li>
              <Link to="/account">Account</Link>
            </li>
          </ul>
        </aside>

        <main className="col-span-12 md:col-span-9 lg:col-span-10">
          <Routes>
            <Route path="/" element={<Navigate to="/cameras" replace />} />
            <Route path="/select-tenant" element={<SelectTenantPage me={me} />} />
            <Route path="/cameras" element={<CamerasPage api={api} />} />
            <Route path="/cameras/:id" element={<CameraDetailPage api={api} />} />
            <Route path="/events" element={<EventsPage api={api} />} />
            <Route path="/account" element={<AccountPage me={me} />} />
          </Routes>
        </main>
      </div>
    </AppShell>
  );
}

function SelectTenantPage({ me }: { me: any }) {
  return (
    <PageCard title="Active Tenant">
      <p className="mb-2 text-sm opacity-70">Seleccioná el tenant desde el navbar superior.</p>
      <ul className="list-disc pl-6">
        {me.memberships?.map((m: any) => (
          <li key={m.id}>
            {m.tenant.name} <Badge>{m.role}</Badge>
          </li>
        ))}
      </ul>
    </PageCard>
  );
}

function CamerasPage({ api }: { api: ApiClient }) {
  const [cameras, setCameras] = useState<any[]>([]);

  useEffect(() => {
    api.get<any>("/cameras", { _start: 0, _end: 50 }).then((res) => setCameras(res.data ?? res));
  }, [api]);

  return (
    <PageCard title="Cameras">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cameras.map((c) => (
          <div key={c.id} className="card bg-base-100 shadow">
            <div className="card-body">
              <h3 className="card-title">{c.name}</h3>
              <p className="text-sm opacity-70">{c.location || "No location"}</p>
              <div className="card-actions justify-end">
                <Link className="btn btn-sm btn-primary" to={`/cameras/${c.id}`}>
                  Open
                </Link>
              </div>
            </div>
          </div>
        ))}
      </div>
    </PageCard>
  );
}

function CameraDetailPage({ api }: { api: ApiClient }) {
  const { id } = useParams();
  const [camera, setCamera] = useState<any>(null);
  const [token, setToken] = useState<any>(null);

  useEffect(() => {
    if (!id) return;
    api.get<any>(`/cameras/${id}`).then((res) => setCamera(res.data ?? res));
  }, [api, id]);

  if (!camera) return <div>Loading...</div>;

  return (
    <PageCard title={camera.name}>
      <div className="space-y-2">
        <div className="rounded-box bg-base-200 p-8 text-center">Viewer mock (no streaming in this iteration)</div>
        <div>RTSP: {camera.rtspUrl}</div>
        <div>Location: {camera.location || "-"}</div>
        <PrimaryButton
          onClick={async () => {
            const res = await api.post<any>(`/cameras/${camera.id}/stream-token`);
            setToken(res);
          }}
        >
          Get stream token
        </PrimaryButton>
        {token && (
          <div className="alert">
            <div className="text-xs break-all">token: {token.token}</div>
            <div className="text-xs">expiresAt: {token.expiresAt}</div>
          </div>
        )}
      </div>
    </PageCard>
  );
}

function EventsPage({ api }: { api: ApiClient }) {
  const [events, setEvents] = useState<any[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  async function search() {
    const res = await api.get<any>("/events", {
      cameraId: cameraId || undefined,
      from: from || undefined,
      to: to || undefined
    });
    setEvents(res.data ?? res);
  }

  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageCard title="Events">
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4">
        <TextInput placeholder="cameraId" value={cameraId} onChange={(e) => setCameraId(e.target.value)} />
        <TextInput type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextInput type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        <PrimaryButton onClick={search}>Filter</PrimaryButton>
      </div>
      <div className="overflow-x-auto">
        <table className="table table-zebra">
          <thead>
            <tr>
              <th>Time</th>
              <th>Camera</th>
              <th>Type</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.timestamp).toLocaleString()}</td>
                <td>{e.cameraId}</td>
                <td>{e.type}</td>
                <td>
                  <Badge
                    className={
                      e.severity === "high"
                        ? "badge-error"
                        : e.severity === "medium"
                          ? "badge-warning"
                          : "badge-success"
                    }
                  >
                    {e.severity}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageCard>
  );
}

function AccountPage({ me }: { me: any }) {
  return (
    <PageCard title="Account">
      <div>Email: {me.user?.email}</div>
      <div>Name: {me.user?.name}</div>
      <div className="mt-2">Memberships: {me.memberships?.length}</div>
    </PageCard>
  );
}

export function PortalApp() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={<ProtectedLayout />} />
    </Routes>
  );
}
