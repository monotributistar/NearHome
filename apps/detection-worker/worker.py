from __future__ import annotations

import asyncio
import os
from datetime import timedelta
from typing import Any, Dict

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy
from temporalio.worker import Worker


@activity.defn
async def call_inference_bridge(payload: Dict[str, Any]) -> Dict[str, Any]:
    import httpx

    bridge_url = os.environ.get("INFERENCE_BRIDGE_URL", "http://inference-bridge:8090").rstrip("/")
    audio_runner_url = os.environ.get("AUDIO_DETECTION_RUNNER_URL", "http://audio-detection-runner:8074").rstrip("/")
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    task_type = str(options.get("taskType") or "object_detection")
    media_kind = str(options.get("mediaKind") or "")
    audio_execution = str(options.get("audioExecution") or "detection_plane")
    is_audio = (
        (media_kind == "audio" or task_type in {"speech_detection", "audio_event_classification", "transcription"})
        and audio_execution != "core"
    )
    infer_payload = {
        "requestId": str(payload.get("requestId") or f"det-{payload.get('jobId', 'unknown')}"),
        "jobId": str(payload["jobId"]),
        "tenantId": str(payload["tenantId"]),
        "cameraId": str(payload["cameraId"]),
        "taskType": task_type,
        "modelRef": str(options.get("modelRef") or "yolo26n@1.0.0"),
        "mediaRef": payload.get("mediaRef", {}),
        "thresholds": options.get("thresholds") if isinstance(options.get("thresholds"), dict) else {},
        "deadlineMs": int(options.get("deadlineMs") or 15000),
        "priority": int(options.get("priority") or 5),
        "provider": str(payload.get("provider") or ("audio_runner" if is_audio else "onprem_bento")),
        "options": options,
    }
    endpoint = f"{audio_runner_url}/v1/infer/audio" if is_audio else f"{bridge_url}/v1/infer"
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(endpoint, json=infer_payload)
        response.raise_for_status()
        return response.json()


@activity.defn
async def report_detection_complete(payload: Dict[str, Any]) -> Dict[str, Any]:
    import httpx

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
    import httpx

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
        retry_policy = RetryPolicy(maximum_attempts=3)
        try:
            result = await workflow.execute_activity(
                call_inference_bridge,
                payload,
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry_policy,
            )
            await workflow.execute_activity(
                report_detection_complete,
                {
                    "jobId": payload["jobId"],
                    "detections": result.get("detections", []),
                    "providerMeta": result.get("providerMeta"),
                },
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry_policy,
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
                retry_policy=retry_policy,
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
