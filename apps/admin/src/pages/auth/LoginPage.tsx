import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell, PageCard, PrimaryButton, TextInput } from "@app/ui";

export function LoginPage({ apiUrl }: { apiUrl: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@nearhome.dev");
  const [password, setPassword] = useState("demo1234");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, audience: "backoffice" })
    });

    if (!res.ok) {
      setError(res.status === 403 ? "Usuario sin acceso al backoffice" : "Credenciales inválidas");
      return;
    }

    const data = await res.json();
    localStorage.setItem("nearhome_access_token", data.accessToken);
    localStorage.removeItem("nearhome_impersonate_role");
    navigate("/");
  }

  return (
    <AppShell>
      <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
        <PageCard title="NearHome Admin Login">
          <form className="space-y-3" onSubmit={onSubmit}>
            <label className="form-control">
              <span className="label-text">Email</span>
              <TextInput aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="form-control">
              <span className="label-text">Password</span>
              <TextInput aria-label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
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
