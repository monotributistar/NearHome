import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiClient, ApiClientError, loadSessionState, saveSessionState } from "@app/api-client";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
export const EVENT_GATEWAY_URL = import.meta.env.VITE_EVENT_GATEWAY_URL ?? "http://localhost:3011";

export const PORTAL_ROUTES = {
  operations: {
    dashboard: "/operations/dashboard",
    cameras: "/operations/cameras",
    cameraDetail: (id: string) => `/operations/cameras/${id}`,
    events: "/operations/events",
    realtime: "/operations/realtime"
  },
  account: {
    households: "/account/households",
    subscriptions: "/account/subscriptions",
    tenant: "/account/tenant",
    profile: "/account/profile"
  },
  viewers: "/viewers",
  plan: "/plan"
} as const;

export type RealtimeEvent = {
  eventId: string;
  eventType: string;
  tenantId: string;
  occurredAt: string;
  sequence: number;
  payload: Record<string, unknown>;
};

export function toWsUrl(httpUrl: string) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

export function matchesTopics(eventType: string, topics: string[]) {
  if (!topics.length) return true;
  return topics.some((topic) => eventType === topic || eventType.startsWith(`${topic}.`));
}

export function formatApiError(error: unknown, fallback: string) {
  if (error instanceof ApiClientError) {
    const details =
      error.details !== undefined
        ? ` | ${typeof error.details === "string" ? error.details : JSON.stringify(error.details)}`
        : "";
    const code = error.code ? `${error.code} | ` : "";
    return `[${error.status}] ${code}${error.message}${details}`;
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return fallback;
}

export function usePortalClient() {
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
