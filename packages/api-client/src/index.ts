export type ApiClientOptions = {
  baseUrl: string;
  getToken: () => string | null;
  getTenantId?: () => string | null;
  onUnauthorized?: () => void;
};

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

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
      const text = await response.text();
      throw new Error(text || `Request failed: ${response.status}`);
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
