from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from temporalio.client import Client
from temporalio.exceptions import WorkflowAlreadyStartedError

from worker import DetectionWorkflow


class DispatchRequest(BaseModel):
    requestId: str | None = None
    jobId: str
    tenantId: str
    cameraId: str
    mode: str = "realtime"
    source: str = "snapshot"
    provider: str = "onprem_bento"
    options: Dict[str, Any] = Field(default_factory=dict)
    mediaRef: Dict[str, Any]


def _task_queue() -> str:
    return os.environ.get("TEMPORAL_TASK_QUEUE", "nearhome-detection")


def _workflow_id(payload: DispatchRequest) -> str:
    # Stable id for idempotent dispatch from control-plane retries.
    return f"det-{payload.jobId}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    temporal_target = os.environ.get("TEMPORAL_SERVER", "temporal:7233")
    app.state.temporal_client = await Client.connect(temporal_target)
    yield


app = FastAPI(title="nearhome-detection-dispatcher", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/workflows/detection-jobs")
async def start_detection_workflow(payload: DispatchRequest) -> Dict[str, str]:
    client: Client = app.state.temporal_client
    task_queue = _task_queue()
    workflow_id = _workflow_id(payload)

    workflow_payload = {
        "requestId": payload.requestId or workflow_id,
        "jobId": payload.jobId,
        "tenantId": payload.tenantId,
        "cameraId": payload.cameraId,
        "mode": payload.mode,
        "source": payload.source,
        "provider": payload.provider,
        "options": payload.options,
        "mediaRef": payload.mediaRef,
    }

    try:
        handle = await client.start_workflow(
            DetectionWorkflow.run,
            workflow_payload,
            id=workflow_id,
            task_queue=task_queue,
        )
        run_id = getattr(handle, "first_execution_run_id", None) or getattr(handle, "run_id", None) or ""
        return {"workflowId": handle.id, "runId": run_id, "taskQueue": task_queue}
    except WorkflowAlreadyStartedError as exc:
        raise HTTPException(status_code=409, detail=f"workflow already started: {exc.workflow_id}") from exc
