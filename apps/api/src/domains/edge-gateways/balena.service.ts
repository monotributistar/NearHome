export type BalenaDevice = {
  uuid: string; deviceName: string; status: string; isOnline: boolean;
  osVersion: string | null; supervisorVersion: string | null;
  lastConnectivityEvent: string | null; ipAddress: string | null;
  appId: string | null; fleetId: string | null; releaseId: string | null;
};
export type BalenaDeviceStatus = {
  uuid: string; isOnline: boolean; status: string;
  supervisorState: string | null; currentRelease: string | null; downloadProgress: number | null;
};

export class BalenaFleetService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  constructor(opts: { baseUrl: string; apiKey: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
  }
  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
  }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...this.headers(), ...(init?.headers ?? {}) } });
    if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`Balena API ${res.status}: ${t.slice(0,200)}`); }
    return res.json() as Promise<T>;
  }
  async listDevices(fleetId: string): Promise<BalenaDevice[]> {
    const filter = encodeURIComponent(`belongs_to__application eq ${fleetId}`);
    const p = await this.request<{ d: Array<Record<string,unknown>> }>(`/v6/device?$filter=${filter}&$select=uuid,device_name,status,is_online,os_version,supervisor_version,last_connectivity_event,ip_address,belongs_to__application,is_running__release`);
    return (p.d ?? []).map(d => ({
      uuid: String(d["uuid"] ?? ""), deviceName: String(d["device_name"] ?? ""),
      status: String(d["status"] ?? "unknown"), isOnline: Boolean(d["is_online"]),
      osVersion: d["os_version"] != null ? String(d["os_version"]) : null,
      supervisorVersion: d["supervisor_version"] != null ? String(d["supervisor_version"]) : null,
      lastConnectivityEvent: d["last_connectivity_event"] != null ? String(d["last_connectivity_event"]) : null,
      ipAddress: d["ip_address"] != null ? String(d["ip_address"]) : null,
      appId: d["belongs_to__application"] != null ? String((d["belongs_to__application"] as Record<string,unknown>)?.["__id"] ?? d["belongs_to__application"]) : null,
      fleetId,
      releaseId: d["is_running__release"] != null ? String((d["is_running__release"] as Record<string,unknown>)?.["__id"] ?? "") : null
    }));
  }
  async updateDeviceConfig(deviceUuid: string, env: Record<string, string>): Promise<void> {
    const dp = await this.request<{ d: Array<{ id: number }> }>(`/v6/device?$filter=uuid eq '${deviceUuid}'&$select=id`);
    const deviceId = dp.d[0]?.id;
    if (!deviceId) throw new Error(`Device ${deviceUuid} not found in Balena`);
    for (const [name, value] of Object.entries(env)) {
      await this.request(`/v6/device_environment_variable`, { method: "POST", body: JSON.stringify({ device: deviceId, name, value }) })
        .catch(async (err: Error) => {
          if (err.message.includes("409")) {
            const ex = await this.request<{ d: Array<{ id: number }> }>(`/v6/device_environment_variable?$filter=device eq ${deviceId} and name eq '${name}'&$select=id`);
            const varId = ex.d[0]?.id;
            if (varId) await this.request(`/v6/device_environment_variable(${varId})`, { method: "PATCH", body: JSON.stringify({ value }) });
          } else throw err;
        });
    }
  }
  async restartService(deviceUuid: string, serviceName: string): Promise<void> {
    await this.request(`/supervisor/v2/applications/restart-service`, { method: "POST", body: JSON.stringify({ uuid: deviceUuid, serviceName }) });
  }
  async getDeviceStatus(deviceUuid: string): Promise<BalenaDeviceStatus> {
    const p = await this.request<{ d: Array<Record<string,unknown>> }>(`/v6/device?$filter=uuid eq '${deviceUuid}'&$select=uuid,is_online,status,supervisor_version,is_running__release,overall_progress`);
    const d = p.d[0];
    if (!d) throw new Error(`Device ${deviceUuid} not found`);
    return {
      uuid: String(d["uuid"] ?? ""), isOnline: Boolean(d["is_online"]),
      status: String(d["status"] ?? "unknown"),
      supervisorState: d["supervisor_version"] != null ? String(d["supervisor_version"]) : null,
      currentRelease: d["is_running__release"] != null ? String((d["is_running__release"] as Record<string,unknown>)?.["__id"] ?? "") : null,
      downloadProgress: d["overall_progress"] != null ? Number(d["overall_progress"]) : null
    };
  }
}
