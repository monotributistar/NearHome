export type ApiClientOptions = {
  baseUrl: string;
  getToken: () => string | null;
  getTenantId?: () => string | null;
  onUnauthorized?: () => void;
};

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export class ApiClientError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(args: { status: number; message: string; code?: string; details?: unknown }) {
    super(args.message);
    this.name = "ApiClientError";
    this.status = args.status;
    this.code = args.code;
    this.details = args.details;
  }
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private buildUrl(path: string, params?: QueryParams) {
    const url = new URL(path, this.options.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      });
    }
    return url.toString();
  }

  private async request<T>(method: string, path: string, body?: unknown, params?: QueryParams): Promise<T> {
    const token = this.options.getToken();
    const tenantId = this.options.getTenantId?.();
    const hasBody = body !== undefined && body !== null;

    const response = await fetch(this.buildUrl(path, params), {
      method,
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(tenantId ? { "X-Tenant-Id": tenantId } : {})
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {})
    });

    if (response.status === 401) {
      this.options.onUnauthorized?.();
      throw new Error("Unauthorized");
    }

    if (!response.ok) {
      let payload: { code?: unknown; message?: unknown; details?: unknown } | null = null;
      let text = "";
      try {
        payload = (await response.json()) as { code?: unknown; message?: unknown; details?: unknown };
      } catch {
        text = await response.text();
      }
      const code = typeof payload?.code === "string" ? payload.code : undefined;
      const message =
        typeof payload?.message === "string" ? payload.message : text.trim().length > 0 ? text : `Request failed: ${response.status}`;
      const details = payload?.details;
      throw new ApiClientError({ status: response.status, code, message, details });
    }

    return response.json() as Promise<T>;
  }

  get<T>(path: string, params?: QueryParams) {
    return this.request<T>("GET", path, undefined, params);
  }

  post<T>(path: string, body?: unknown, params?: QueryParams) {
    return this.request<T>("POST", path, body, params);
  }

  put<T>(path: string, body?: unknown, params?: QueryParams) {
    return this.request<T>("PUT", path, body, params);
  }

  delete<T>(path: string, params?: QueryParams) {
    return this.request<T>("DELETE", path, undefined, params);
  }
}

export type SessionState = {
  accessToken: string | null;
  activeTenantId: string | null;
};

const TOKEN_KEY = "nearhome_access_token";
const TENANT_KEY = "nearhome_active_tenant";

export function loadSessionState(): SessionState {
  return {
    accessToken: localStorage.getItem(TOKEN_KEY),
    activeTenantId: localStorage.getItem(TENANT_KEY)
  };
}

export function saveSessionState(state: Partial<SessionState>) {
  if (state.accessToken !== undefined) {
    if (state.accessToken) {
      localStorage.setItem(TOKEN_KEY, state.accessToken);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }

  if (state.activeTenantId !== undefined) {
    if (state.activeTenantId) {
      localStorage.setItem(TENANT_KEY, state.activeTenantId);
    } else {
      localStorage.removeItem(TENANT_KEY);
    }
  }
}
