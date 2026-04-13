import { ApiClient } from "@app/api-client";
import { PageCard, Surface, Badge } from "@app/ui";

export function ProfilePage({ me }: { me: any; api?: ApiClient }) {
  return (
    <PageCard title="My Profile">
      <Surface className="space-y-2 p-4">
        <div className="text-sm"><span className="font-medium text-slate-700">Name:</span> {me.user?.name}</div>
        <div className="text-sm"><span className="font-medium text-slate-700">Email:</span> {me.user?.email}</div>
        <div className="mt-3 text-sm font-medium text-slate-700">Places ({me.memberships?.length})</div>
        <ul className="space-y-1">
          {me.memberships?.map((m: any) => (
            <li key={m.id} className="flex items-center gap-2 text-sm">
              <span>{m.tenant.name}</span>
              <Badge>{m.role}</Badge>
            </li>
          ))}
        </ul>
      </Surface>
    </PageCard>
  );
}

export function SelectTenantPage({ me }: { me: any }) {
  return (
    <PageCard title="Active Place">
      <p className="mb-3 text-sm text-slate-600">Select a place from the switcher at the top.</p>
      <ul className="space-y-1">
        {me.memberships?.map((m: any) => (
          <li key={m.id} className="flex items-center gap-2 text-sm">
            <span>{m.tenant.name}</span>
            <Badge>{m.role}</Badge>
          </li>
        ))}
      </ul>
    </PageCard>
  );
}
