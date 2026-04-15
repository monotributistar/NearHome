import { useState } from "react";
import { Navigate, useNavigate, Link } from "react-router-dom";
import { AppShell, PageCard, PrimaryButton, TextInput } from "@app/ui";
import { usePortalClient, PORTAL_ROUTES, formatApiError } from "../../lib/client.js";

type Step = "account" | "place" | "done";

export function RegisterPage() {
  const { api, state, setSession } = usePortalClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("account");
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [placeName, setPlaceName] = useState("");
  const [placeAddress, setPlaceAddress] = useState("");

  if (state.accessToken) return <Navigate to={PORTAL_ROUTES.account.tenant} replace />;

  if (step === "done") {
    return (
      <AppShell>
        <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
          <PageCard title="You're all set!">
            <div className="space-y-4 text-center">
              <div className="text-4xl">🎉</div>
              <p className="text-slate-700">
                Welcome to NearHome! Your account has been created and your NearHome hub is on its way.
              </p>
              <p className="text-sm text-slate-500">
                Once your device arrives, connect it to your network and it will automatically register to your place.
              </p>
              <PrimaryButton className="w-full" onClick={() => navigate(PORTAL_ROUTES.account.tenant)}>
                Go to my place
              </PrimaryButton>
            </div>
          </PageCard>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
        <PageCard title={step === "account" ? "Create your account" : "Name your place"}>
          <div className="mb-4 flex items-center gap-2">
            <div className={`h-2 flex-1 rounded-full ${step === "account" ? "bg-slate-800" : "bg-slate-300"}`} />
            <div className={`h-2 flex-1 rounded-full ${step === "place" ? "bg-slate-800" : "bg-slate-300"}`} />
          </div>

          {step === "account" && (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                if (password !== confirmPassword) {
                  setError("Passwords do not match");
                  return;
                }
                setStep("place");
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
              <PrimaryButton type="submit" className="w-full">
                Continue
              </PrimaryButton>
            </form>
          )}

          {step === "place" && (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  const data = await api.post<any>("/auth/register", {
                    name,
                    email,
                    password,
                    placeName,
                    placeAddress: placeAddress.trim() || undefined
                  });
                  setSession({ accessToken: data.accessToken, activeTenantId: data.tenant?.id ?? null });
                  setStep("done");
                } catch (cause) {
                  setError(formatApiError(cause, "Registration failed. Please try again."));
                }
              }}
            >
              <p className="text-sm text-slate-600">
                Give your home or business a name. This is where your NearHome hub will be installed.
              </p>
              <label className="form-control">
                <span className="label-text">Place name</span>
                <TextInput
                  placeholder="e.g. My Home, Office, Beach House"
                  value={placeName}
                  onChange={(e) => setPlaceName(e.target.value)}
                  required
                  minLength={2}
                />
              </label>
              <label className="form-control">
                <span className="label-text">Address (optional)</span>
                <TextInput
                  placeholder="123 Main St"
                  value={placeAddress}
                  onChange={(e) => setPlaceAddress(e.target.value)}
                />
              </label>
              {error && <div className="alert alert-error py-2 text-sm">{error}</div>}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  onClick={() => { setError(null); setStep("account"); }}
                >
                  Back
                </button>
                <PrimaryButton type="submit" className="flex-1">
                  Create my place
                </PrimaryButton>
              </div>
            </form>
          )}

          <p className="mt-4 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link to="/login" className="text-slate-700 underline underline-offset-2">
              Sign in
            </Link>
          </p>
        </PageCard>
      </div>
    </AppShell>
  );
}
