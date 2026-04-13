import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiClient } from "@app/api-client";
import { PageCard, PrimaryButton, TextInput, SelectInput, DataTable, Badge } from "@app/ui";
import { PORTAL_ROUTES, formatApiError } from "../../lib/client.js";

export function CamerasPage({ api }: { api: ApiClient }) {
  const [cameras, setCameras] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [cameraForm, setCameraForm] = useState({
    id: "",
    name: "",
    rtspUrl: "",
    location: "",
    description: "",
    isActive: true
  });

  async function loadCameras() {
    try {
      const res = await api.get<any>("/cameras", { _start: 0, _end: 50 });
      setCameras(res.data ?? res);
      setError(null);
    } catch (cause) {
      setError(formatApiError(cause, "Could not load cameras"));
    }
  }

  function resetForm() {
    setCameraForm({ id: "", name: "", rtspUrl: "", location: "", description: "", isActive: true });
  }

  useEffect(() => {
    void loadCameras();
  }, [api]);

  return (
    <PageCard title="RTSP Cameras">
      {error && <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {ok && <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{ok}</div>}

      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-6">
        <TextInput placeholder="Camera name" value={cameraForm.name} onChange={(e) => setCameraForm((p) => ({ ...p, name: e.target.value }))} />
        <TextInput placeholder="RTSP URL" value={cameraForm.rtspUrl} onChange={(e) => setCameraForm((p) => ({ ...p, rtspUrl: e.target.value }))} />
        <TextInput placeholder="Location" value={cameraForm.location} onChange={(e) => setCameraForm((p) => ({ ...p, location: e.target.value }))} />
        <TextInput placeholder="Description" value={cameraForm.description} onChange={(e) => setCameraForm((p) => ({ ...p, description: e.target.value }))} />
        <SelectInput value={String(cameraForm.isActive)} onChange={(e) => setCameraForm((p) => ({ ...p, isActive: e.target.value === "true" }))}>
          <option value="true">Active</option>
          <option value="false">Draft</option>
        </SelectInput>
        <div className="flex gap-2">
          <PrimaryButton
            onClick={async () => {
              if (!cameraForm.name.trim() || !cameraForm.rtspUrl.trim()) {
                setError("Name and RTSP URL are required.");
                return;
              }
              try {
                if (cameraForm.id) {
                  await api.put(`/cameras/${cameraForm.id}`, {
                    name: cameraForm.name.trim(),
                    rtspUrl: cameraForm.rtspUrl.trim(),
                    location: cameraForm.location.trim() || null,
                    description: cameraForm.description.trim() || null,
                    isActive: cameraForm.isActive
                  });
                  setOk("Camera updated");
                } else {
                  await api.post("/cameras", {
                    name: cameraForm.name.trim(),
                    rtspUrl: cameraForm.rtspUrl.trim(),
                    location: cameraForm.location.trim() || undefined,
                    description: cameraForm.description.trim() || undefined,
                    isActive: cameraForm.isActive
                  });
                  setOk("Camera created");
                }
                setError(null);
                resetForm();
                await loadCameras();
              } catch (cause) {
                setError(formatApiError(cause, "Could not save camera"));
              }
            }}
          >
            {cameraForm.id ? "Save" : "Create"}
          </PrimaryButton>
          <button
            className="inline-flex items-center justify-center rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            type="button"
            onClick={resetForm}
          >
            Clear
          </button>
        </div>
      </div>

      <DataTable>
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Location</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Active</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {cameras.map((camera) => (
            <tr key={camera.id}>
              <td className="px-3 py-2">{camera.name}</td>
              <td className="px-3 py-2 text-sm text-slate-600">{camera.location || "-"}</td>
              <td className="px-3 py-2"><Badge>{camera.lifecycleStatus}</Badge></td>
              <td className="px-3 py-2 text-sm">{camera.isActive ? "yes" : "no"}</td>
              <td className="px-3 py-2">
                <div className="flex gap-2">
                  <button
                    className="inline-flex items-center justify-center rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    type="button"
                    onClick={() =>
                      setCameraForm({
                        id: camera.id,
                        name: camera.name ?? "",
                        rtspUrl: camera.rtspUrl ?? "",
                        location: camera.location ?? "",
                        description: camera.description ?? "",
                        isActive: Boolean(camera.isActive)
                      })
                    }
                  >
                    Edit
                  </button>
                  <Link
                    className="inline-flex items-center justify-center rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    to={PORTAL_ROUTES.operations.cameraDetail(camera.id)}
                  >
                    Open
                  </Link>
                </div>
              </td>
            </tr>
          ))}
          {!cameras.length && (
            <tr>
              <td colSpan={5} className="px-3 py-4 text-center text-sm text-slate-500">No cameras added yet.</td>
            </tr>
          )}
        </tbody>
      </DataTable>
    </PageCard>
  );
}
