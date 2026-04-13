import { useList } from "@refinedev/core";
import { PageCard, Surface } from "@app/ui";

export function PlansPage() {
  const { result } = useList({ resource: "plans" } as any);
  return (
    <PageCard title="Plans">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(result?.data ?? []).map((p: any) => (
          <Surface key={p.id} className="p-4">
            <h3 className="text-lg font-bold">{p.name}</h3>
            <p className="text-sm text-slate-500">{p.code}</p>
            <div className="mt-2 text-sm">Max cameras: {p.limits.maxCameras}</div>
            <div className="text-sm">Retention days: {p.limits.retentionDays}</div>
            <div className="mt-2 text-sm">
              Features:{" "}
              {Object.keys(p.features)
                .filter((f) => p.features[f])
                .join(", ")}
            </div>
          </Surface>
        ))}
      </div>
    </PageCard>
  );
}
