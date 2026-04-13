import { useEffect, useState } from "react";
import { ApiClient } from "@app/api-client";
import { PageCard, PrimaryButton, DataTable, Badge, Surface } from "@app/ui";
import { formatApiError } from "../../lib/client.js";

export function ViewersPage({ api }: { api: ApiClient }) {
  const [viewers, setViewers] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteExpiry, setInviteExpiry] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadViewers() {
    try {
      const res = await api.get<any>("/users");
      const all: any[] = res.data ?? res;
      setViewers(all.filter((u) => u.role === "client_user"));
      setError(null);
    } catch (cause) {
      setError(formatApiError(cause, "Could not load viewers"));
    }
  }

  async function generateInvite() {
    setError(null);
    try {
      const res = await api.post<any>("/auth/invite", { role: "client_user", label: "Viewer invite" });
      setInviteLink(res.inviteUrl);
      setInviteExpiry(res.expiresAt);
      setOk("Invite link created — share it with your viewer");
      setCopied(false);
    } catch (cause) {
      setError(formatApiError(cause, "Could not generate invite link"));
    }
  }

  async function deactivateViewer(userId: string) {
    setError(null);
    try {
      await api.put(`/users/${userId}`, { isActive: false });
      setOk("Viewer deactivated");
      await loadViewers();
    } catch (cause) {
      setError(formatApiError(cause, "Could not deactivate viewer"));
    }
  }

  useEffect(() => {
    void loadViewers();
  }, [api]);

  return (
    <PageCard title="Viewers">
      {error && <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {ok && <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{ok}</div>}

      <div className="mb-4">
        <PrimaryButton onClick={generateInvite}>Generate invite link</PrimaryButton>
        <p className="mt-1 text-xs text-slate-500">Creates a shareable link valid for 7 days. The viewer creates their own account.</p>
      </div>

      {inviteLink && (
        <Surface className="mb-4 space-y-2 p-4">
          <div className="text-sm font-medium">Invite link</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-slate-100 px-2 py-1.5 text-xs">{inviteLink}</code>
            <button
              type="button"
              className="shrink-0 rounded border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100"
              onClick={() => {
                navigator.clipboard.writeText(inviteLink).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          {inviteExpiry && (
            <div className="text-xs text-slate-500">Expires: {new Date(inviteExpiry).toLocaleString()}</div>
          )}
        </Surface>
      )}

      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Email</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {viewers.map((viewer) => (
            <tr key={viewer.id}>
              <td className="px-3 py-2">{viewer.name}</td>
              <td className="px-3 py-2 text-sm text-slate-600">{viewer.email}</td>
              <td className="px-3 py-2">
                <Badge className={viewer.isActive ? "" : "border-slate-200 bg-slate-50 text-slate-500"}>
                  {viewer.isActive ? "active" : "inactive"}
                </Badge>
              </td>
              <td className="px-3 py-2">
                {viewer.isActive && (
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    onClick={() => deactivateViewer(viewer.id)}
                  >
                    Deactivate
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!viewers.length && (
            <tr>
              <td colSpan={4} className="px-3 py-4 text-center text-sm text-slate-500">
                No viewers yet. Generate an invite link to add one.
              </td>
            </tr>
          )}
        </tbody>
      </DataTable>
    </PageCard>
  );
}
