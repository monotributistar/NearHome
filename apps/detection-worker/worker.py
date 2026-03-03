from __future__ import annotations

import asyncio
import os
from datetime import timedelta
from typing import Any, Dict

import httpx
from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.worker import Worker


@activity.defn
async def call_inference_bridge(payload: Dict[str, Any]) -> Dict[str, Any]:
    bridge_url = os.environ.get("INFERENCE_BRIDGE_URL", "http://inference-bridge:8090").rstrip("/")
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(f"{bridge_url}/v1/infer", json=payload)
        response.raise_for_status()
        return response.json()


@activity.defn
async def report_detection_complete(payload: Dict[str, Any]) -> Dict[str, Any]:
    control_plane_url = os.environ.get("CONTROL_PLANE_URL", "http://api:3001").rstrip("/")
    callback_secret = os.environ.get("DETECTION_CALLBACK_SECRET", "dev-detection-callback-secret")
    job_id = str(payload["jobId"])
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            f"{control_plane_url}/internal/detections/jobs/{job_id}/complete",
            headers={"x-detection-callback-secret": callback_secret},
            json={
                "detections": payload.get("detections", []),
                "providerMeta": payload.get("providerMeta"),
            },
        )
        response.raise_for_status()
        return response.json()


@activity.defn
async def report_detection_failure(payload: Dict[str, Any]) -> Dict[str, Any]:
    control_plane_url = os.environ.get("CONTROL_PLANE_URL", "http://api:3001").rstrip("/")
    callback_secret = os.environ.get("DETECTION_CALLBACK_SECRET", "dev-detection-callback-secret")
    job_id = str(payload["jobId"])
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            f"{control_plane_url}/internal/detections/jobs/{job_id}/fail",
            headers={"x-detection-callback-secret": callback_secret},
            json={
                "errorCode": payload.get("errorCode", "DETECTION_WORKFLOW_ERROR"),
                "errorMessage": payload.get("errorMessage", "workflow failed"),
            },
        )
        response.raise_for_status()
        return response.json()


@workflow.defn
class DetectionWorkflow:
    @workflow.run
    async def run(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            result = await workflow.execute_activity(
                call_inference_bridge,
                payload,
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy={"maximum_attempts": 3},
            )
            await workflow.execute_activity(
                report_detection_complete,
                {
                    "jobId": payload["jobId"],
                    "detections": result.get("detections", []),
                    "providerMeta": result.get("providerMeta"),
                },
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy={"maximum_attempts": 3},
            )
            return result
        except Exception as exc:
            await workflow.execute_activity(
                report_detection_failure,
                {
                    "jobId": payload.get("jobId"),
                    "errorCode": "DETECTION_WORKFLOW_ERROR",
                    "errorMessage": str(exc),
                },
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy={"maximum_attempts": 3},
            )
            raise


async def main() -> None:
    temporal_target = os.environ.get("TEMPORAL_SERVER", "temporal:7233")
    task_queue = os.environ.get("TEMPORAL_TASK_QUEUE", "nearhome-detection")

    client = await Client.connect(temporal_target)
    worker = Worker(
        client,
        task_queue=task_queue,
        workflows=[DetectionWorkflow],
        activities=[call_inference_bridge, report_detection_complete, report_detection_failure],
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
