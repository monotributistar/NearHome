import { useState } from "react";
import { Navigate, useNavigate, Link } from "react-router-dom";
import { AppShell, PageCard, PrimaryButton, TextInput } from "@app/ui";
import { usePortalClient, PORTAL_ROUTES } from "../../lib/client.js";

export function LoginPage() {
  const { api, state, setSession } = usePortalClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (state.accessToken) return <Navigate to={PORTAL_ROUTES.account.tenant} replace />;

  return (
    <AppShell>
      <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
        <PageCard title="NearHome Portal">
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const data = await api.post<any>("/auth/login", { email, password, audience: "portal" });
                setSession({ accessToken: data.accessToken });
                navigate(PORTAL_ROUTES.account.tenant);
              } catch {
                setError("Invalid credentials");
              }
            }}
          >
            <label className="form-control">
              <span className="label-text">Email</span>
              <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="form-control">
              <span className="label-text">Password</span>
              <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <div className="alert alert-error py-2 text-sm">{error}</div>}
            <PrimaryButton type="submit" className="w-full">
              Sign in
            </PrimaryButton>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500">
            Don't have an account?{" "}
            <Link to="/register" className="text-slate-700 underline underline-offset-2">
              Create one
            </Link>
          </p>
        </PageCard>
      </div>
    </AppShell>
  );
}
