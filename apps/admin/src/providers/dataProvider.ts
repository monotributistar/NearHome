import type { DataProvider, BaseRecord, GetListParams, GetOneParams, CreateParams, UpdateParams, DeleteOneParams, CustomParams } from "@refinedev/core";
import { getToken, getTenantId } from "../lib/admin.js";

function apiHeaders(): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  const tenantId = getTenantId();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  return headers;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    try { message = (JSON.parse(text) as { message?: string }).message ?? message; } catch { /* */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export function createNhDataProvider(apiUrl: string): DataProvider {
  const base = apiUrl.replace(/\/$/, "");

  return {
    getList: async ({ resource, pagination, sorters, filters }: GetListParams) => {
      const params = new URLSearchParams();
      const page = pagination?.current ?? 1;
      const perPage = pagination?.pageSize ?? 25;
      params.set("_start", String((page - 1) * perPage));
      params.set("_end", String(page * perPage));
      if (sorters?.[0]) {
        params.set("_sort", sorters[0].field);
        params.set("_order", sorters[0].order.toUpperCase());
      }
      if (filters) {
        for (const f of filters) {
          if ("field" in f) params.set(`_filter_${f.field}`, String(f.value));
        }
      }
      const url = `${base}/${resource}?${params}`;
      const res = await fetch(url, { headers: apiHeaders() });
      const payload = await handleResponse<{ data?: BaseRecord[]; total?: number } | BaseRecord[]>(res);
      if (Array.isArray(payload)) {
        return { data: payload, total: payload.length };
      }
      return { data: payload.data ?? [], total: payload.total ?? (payload.data ?? []).length };
    },

    getOne: async ({ resource, id }: GetOneParams) => {
      const res = await fetch(`${base}/${resource}/${id}`, { headers: apiHeaders() });
      const payload = await handleResponse<{ data?: BaseRecord } | BaseRecord>(res);
      const record = ("data" in payload && payload.data) ? payload.data : payload as BaseRecord;
      return { data: record };
    },

    create: async ({ resource, variables }: CreateParams) => {
      const res = await fetch(`${base}/${resource}`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify(variables)
      });
      const payload = await handleResponse<BaseRecord>(res);
      return { data: payload };
    },

    update: async ({ resource, id, variables }: UpdateParams) => {
      const res = await fetch(`${base}/${resource}/${id}`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify(variables)
      });
      const payload = await handleResponse<BaseRecord>(res);
      return { data: payload };
    },

    deleteOne: async ({ resource, id }: DeleteOneParams) => {
      const res = await fetch(`${base}/${resource}/${id}`, {
        method: "DELETE",
        headers: apiHeaders()
      });
      const payload = res.status === 204 ? { id } : await handleResponse<BaseRecord>(res);
      return { data: payload as BaseRecord };
    },

    custom: async ({ url, method = "get", payload: body }: CustomParams) => {
      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers: apiHeaders(),
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const data = await handleResponse<BaseRecord>(res);
      return { data };
    },

    getApiUrl: () => base,
  };
}
