import { useEffect, useMemo, useRef, useState } from "react";
import { ApiClient, loadSessionState, saveSessionState } from "@app/api-client";
import { AppShell, PageCard, PrimaryButton, SelectInput, TextInput, Badge, WorkspaceShell, type WorkspaceNavGroup } from "@app/ui";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { Camera, Internet, UserCircle, ViewGrid, WarningSquare } from "iconoir-react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const EVENT_GATEWAY_URL = import.meta.env.VITE_EVENT_GATEWAY_URL ?? "http://localhost:3011";

type RealtimeEvent = {
  eventId: string;
  eventType: string;
  tenantId: string;
  occurredAt: string;
  sequence: number;
  payload: Record<string, unknown>;
};

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
  const navigation: WorkspaceNavGroup[] = [
    {
      title: "Operaciones",
      items: [
        { to: "/cameras", label: "Cámaras", icon: <Camera width={16} height={16} /> },
        { to: "/events", label: "Eventos", icon: <WarningSquare width={16} height={16} /> },
        { to: "/realtime", label: "Realtime", icon: <Internet width={16} height={16} /> }
      ]
    },
    {
      title: "Cuenta",
      items: [
        { to: "/select-tenant", label: "Tenant activo", icon: <ViewGrid width={16} height={16} /> },
        { to: "/account", label: "Perfil", icon: <UserCircle width={16} height={16} /> }
      ]
    }
  ];

  return (
    <WorkspaceShell
      product="NearHome App"
      subtitle="Vista operativa para usuarios finales"
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
        <Route path="/" element={<Navigate to="/cameras" replace />} />
        <Route path="/select-tenant" element={<SelectTenantPage me={me} />} />
        <Route path="/cameras" element={<CamerasPage api={api} />} />
        <Route path="/cameras/:id" element={<CameraDetailPage api={api} />} />
        <Route path="/events" element={<EventsPage api={api} />} />
        <Route path="/realtime" element={<RealtimePage api={api} tenantId={state.activeTenantId} />} />
        <Route path="/account" element={<AccountPage me={me} />} />
      </Routes>
    </WorkspaceShell>
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
  const [session, setSession] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);

  async function loadSessions(cameraId: string) {
    const res = await api.get<any>("/stream-sessions", { cameraId, _start: 0, _end: 5, _sort: "createdAt", _order: "DESC" });
    setSessions(res.data ?? []);
  }

  useEffect(() => {
    if (!id) return;
    api.get<any>(`/cameras/${id}`).then((res) => setCamera(res.data ?? res));
    loadSessions(id).catch(() => setSessions([]));
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
            setSession(res.session ?? null);
            await loadSessions(camera.id);
          }}
        >
          Get stream token
        </PrimaryButton>
        {token && (
          <div className="alert">
            <div className="text-xs break-all">token: {token.token}</div>
            <div className="text-xs">expiresAt: {token.expiresAt}</div>
            {token.playbackUrl && (
              <div className="text-xs break-all">
                playbackUrl: <a className="link" href={token.playbackUrl} target="_blank" rel="noreferrer">{token.playbackUrl}</a>
              </div>
            )}
          </div>
        )}
        {token?.playbackUrl && (
          <div className="rounded-box bg-base-200 p-3">
            <div className="mb-2 text-xs opacity-70">Playback preview (MVP)</div>
            <video className="w-full rounded-box" controls muted src={token.playbackUrl} />
          </div>
        )}
        {session && (
          <div className="space-y-2 rounded-box bg-base-200 p-3">
            <div className="text-sm">
              Session: <Badge data-testid="stream-session-status">{session.status}</Badge>
            </div>
            <div className="flex gap-2">
              <PrimaryButton
                data-testid="stream-activate"
                type="button"
                disabled={session.status !== "issued"}
                onClick={async () => {
                  const res = await api.post<any>(`/stream-sessions/${session.id}/activate`, {});
                  setSession(res.data ?? res);
                  await loadSessions(camera.id);
                }}
              >
                Mark active
              </PrimaryButton>
              <PrimaryButton
                data-testid="stream-end"
                type="button"
                disabled={session.status === "ended" || session.status === "expired"}
                onClick={async () => {
                  const res = await api.post<any>(`/stream-sessions/${session.id}/end`, { reason: "portal user ended" });
                  setSession(res.data ?? res);
                  await loadSessions(camera.id);
                }}
              >
                End session
              </PrimaryButton>
            </div>
          </div>
        )}
        <div>
          <h3 className="mb-2 text-sm font-semibold">Recent stream sessions</h3>
          <div className="space-y-1">
            {sessions.map((item) => (
              <div key={item.id} className="flex items-center justify-between rounded-box bg-base-200 px-3 py-2 text-xs">
                <span className="truncate">{item.id}</span>
                <Badge>{item.status}</Badge>
              </div>
            ))}
            {!sessions.length && <div className="text-xs opacity-70">No stream sessions yet</div>}
          </div>
        </div>
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

function RealtimePage({ api, tenantId }: { api: ApiClient; tenantId: string | null }) {
  const [status, setStatus] = useState<"connecting" | "connected" | "degraded" | "disconnected">("disconnected");
  const [transport, setTransport] = useState<"ws" | "sse" | "none">("none");
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [topics, setTopics] = useState("incident,detection,stream");
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);
  const stopRef = useRef(false);

  useEffect(() => {
    if (!tenantId) {
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
        const tokenResponse = await api.get<any>("/events/ws-token");
        const wsUrl = new URL(toWsUrl(EVENT_GATEWAY_URL));
        wsUrl.searchParams.set("token", tokenResponse.data.token);
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
  }, [api, tenantId, topics]);

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
