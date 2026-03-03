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


@workflow.defn
class DetectionWorkflow:
    @workflow.run
    async def run(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        result = await workflow.execute_activity(
            call_inference_bridge,
            payload,
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy={"maximum_attempts": 3},
        )
        return result


async def main() -> None:
    temporal_target = os.environ.get("TEMPORAL_SERVER", "temporal:7233")
    task_queue = os.environ.get("TEMPORAL_TASK_QUEUE", "nearhome-detection")

    client = await Client.connect(temporal_target)
    worker = Worker(
        client,
        task_queue=task_queue,
        workflows=[DetectionWorkflow],
        activities=[call_inference_bridge],
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
