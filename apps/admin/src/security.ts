import type { AccessControlProvider, AuthProvider } from "@refinedev/core";

type Role = "tenant_admin" | "monitor" | "client_user";

export const authProvider: AuthProvider = {
  login: async ({ email, password }: any) => {
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? "http://localhost:3001"}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (!res.ok) {
      return { success: false, error: { message: "Credenciales inválidas", name: "Login error" } };
    }

    const data = await res.json();
    localStorage.setItem("nearhome_access_token", data.accessToken);
    return { success: true, redirectTo: "/" };
  },
  logout: async () => {
    localStorage.removeItem("nearhome_access_token");
    localStorage.removeItem("nearhome_active_tenant");
    localStorage.removeItem("nearhome_me");
    return { success: true, redirectTo: "/login" };
  },
  check: async () => {
    const token = localStorage.getItem("nearhome_access_token");
    if (!token) {
      return { authenticated: false, redirectTo: "/login" };
    }
    return { authenticated: true };
  },
  getIdentity: async () => {
    const raw = localStorage.getItem("nearhome_me");
    if (!raw) return null;
    return JSON.parse(raw).user;
  },
  getPermissions: async () => {
    const raw = localStorage.getItem("nearhome_me");
    if (!raw) return null;
    const me = JSON.parse(raw);
    const tenantId = localStorage.getItem("nearhome_active_tenant");
    const role = me.memberships?.find((m: any) => m.tenantId === tenantId)?.role;
    return role ?? null;
  },
  onError: async () => ({ error: undefined })
};

const ACL: Record<Role, Record<string, string[]>> = {
  tenant_admin: {
    tenants: ["list", "create", "edit", "show", "delete"],
    users: ["list", "create", "edit", "show"],
    memberships: ["list", "create", "edit", "show"],
    cameras: ["list", "create", "edit", "show", "delete"],
    plans: ["list", "show"],
    subscriptions: ["list", "create", "edit", "show"]
  },
  monitor: {
    tenants: ["list", "show"],
    users: ["list", "show"],
    memberships: ["list", "show"],
    cameras: ["list", "show"],
    plans: ["list"],
    subscriptions: ["list", "show"]
  },
  client_user: {
    tenants: ["list", "show"],
    users: [],
    memberships: [],
    cameras: ["list", "show"],
    plans: [],
    subscriptions: ["show"]
  }
};

export const accessControlProvider: AccessControlProvider = {
  can: async ({ resource, action }) => {
    const raw = localStorage.getItem("nearhome_me");
    const tenantId = localStorage.getItem("nearhome_active_tenant");

    if (!raw || !tenantId || !resource) return { can: false };

    const me = JSON.parse(raw);
    const role = me.memberships?.find((m: any) => m.tenantId === tenantId)?.role as Role | undefined;

    if (!role) return { can: false };

    return { can: ACL[role][resource]?.includes(action) ?? false };
  }
};
