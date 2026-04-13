import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { AppShell, PageCard, PrimaryButton, TextInput } from "@app/ui";
import { usePortalClient, PORTAL_ROUTES, formatApiError } from "../../lib/client.js";

function decodeInviteToken(token: string): { tenantId?: string; role?: string; label?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload;
  } catch {
    return null;
  }
}

const ROLE_LABELS: Record<string, string> = {
  monitor: "User",
  client_user: "Viewer",
  tenant_admin: "Operator"
};

export function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const { api, setSession } = usePortalClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const claims = token ? decodeInviteToken(token) : null;

  if (!token || !claims?.tenantId) {
    return (
      <AppShell>
        <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
          <PageCard title="Invalid invite">
            <p className="text-sm text-slate-600">This invite link is invalid or has expired.</p>
            <Link to="/login" className="mt-3 inline-block text-sm text-slate-700 underline underline-offset-2">
              Go to login
            </Link>
          </PageCard>
        </div>
      </AppShell>
    );
  }

  const roleLabel = ROLE_LABELS[claims.role ?? ""] ?? claims.role ?? "Member";

  return (
    <AppShell>
      <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
        <PageCard title="Accept invitation">
          <div className="mb-4 rounded-lg bg-slate-50 px-4 py-3 text-sm">
            <p className="font-medium text-slate-800">You've been invited to join as a {roleLabel}</p>
            {claims.label && <p className="mt-1 text-slate-500">{claims.label}</p>}
          </div>

          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              if (password !== confirmPassword) {
                setError("Passwords do not match");
                return;
              }
              setSubmitting(true);
              try {
                const data = await api.post<any>("/auth/invite/accept", { token, name, email, password });
                setSession({ accessToken: data.accessToken, activeTenantId: data.tenant?.id ?? null });
                navigate(PORTAL_ROUTES.operations.cameras);
              } catch (cause) {
                setError(formatApiError(cause, "Could not accept invite. The link may have expired."));
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <label className="form-control">
              <span className="label-text">Full name</span>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
            </label>
            <label className="form-control">
              <span className="label-text">Email</span>
              <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="form-control">
              <span className="label-text">Password</span>
              <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              <span className="label-text-alt mt-1 text-xs text-slate-500">
                Min 8 characters, uppercase, lowercase, and number
              </span>
            </label>
            <label className="form-control">
              <span className="label-text">Confirm password</span>
              <TextInput type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            </label>
            {error && <div className="alert alert-error py-2 text-sm">{error}</div>}
            <PrimaryButton type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Creating account..." : "Accept & create account"}
            </PrimaryButton>
          </form>

          <p className="mt-4 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link to="/login" className="text-slate-700 underline underline-offset-2">
              Sign in instead
            </Link>
          </p>
        </PageCard>
      </div>
    </AppShell>
  );
}
