"""HuggingFace Space client using Gradio 5 SSE protocol.

Communicates with HF Zero GPU Spaces via REST/SSE — no gradio_client library needed.
Handles cold starts, keep-warm pings, and SSE event parsing.

Protocol:
  1. Upload:  POST /gradio_api/upload  (multipart file)
  2. Start:   POST /gradio_api/call/<fn>  → {event_id}
  3. Poll:    GET  /gradio_api/call/<fn>/<event_id>  → SSE stream
  4. Result:  event: complete / data: [result_json]
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger("inference-bridge.hf")

HF_TOKEN = os.environ.get("HF_TOKEN", "")
HF_COLD_START_TIMEOUT_S = int(os.environ.get("HF_COLD_START_TIMEOUT_S", "30"))
HF_KEEP_WARM_INTERVAL_S = int(os.environ.get("HF_KEEP_WARM_INTERVAL_S", "240"))

# Default Space IDs
HF_SPACE_YOLO = os.environ.get("HF_SPACE_YOLO", "monotributistar/yolo-detector")
HF_YOLO_FN = os.environ.get("HF_YOLO_FN", "/predict")

HF_SPACE_FACE = os.environ.get("HF_SPACE_FACE", "monotributistar/face-embedder")
HF_FACE_FN = os.environ.get("HF_FACE_FN", "/embed_faces")


class HFSpaceClient:
    """Client for a single HF Zero GPU Space."""

    def __init__(self, space_id: str, fn_name: str = "/predict"):
        self.space_id = space_id
        self.fn_name = fn_name
        self.base_url = f"https://{space_id.replace('/', '-')}.hf.space"

        headers = {}
        if HF_TOKEN:
            headers["Authorization"] = f"Bearer {HF_TOKEN}"

        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=HF_COLD_START_TIMEOUT_S + 10,
        )
        self._last_keep_warm = 0.0
        self._healthy = False

    async def upload_file(self, data: bytes, filename: str = "frame.jpg") -> str:
        """Upload a file to the Space. Returns the file path on the server."""
        resp = await self._client.post(
            "/gradio_api/upload",
            files={"files": (filename, data, "image/jpeg")},
        )
        resp.raise_for_status()
        result = resp.json()
        # Gradio 5 returns list of file paths
        if isinstance(result, list) and len(result) > 0:
            return result[0]
        return result

    async def call(self, file_path: str, params: list = None) -> str:
        """Start an inference call. Returns event_id.

        Args:
            file_path: server path from upload
            params: additional parameters for the Space function (after file_path dict).
                    Default: YOLO params [0.25, 0.45, 100]
        """
        if params is None:
            params = [0.25, 0.45, 100]  # YOLO defaults
        data_list = [{"path": file_path}] + params
        resp = await self._client.post(
            f"/gradio_api/call{self.fn_name}",
            json={"data": data_list},
        )
        resp.raise_for_status()
        result = resp.json()
        return result.get("event_id", "")

    async def poll_result(self, event_id: str) -> List[Any]:
        """Poll SSE stream for inference result.

        Returns the parsed data array from the 'complete' event.
        """
        url = f"/gradio_api/call{self.fn_name}/{event_id}"
        async with self._client.stream("GET", url) as response:
            response.raise_for_status()
            current_event = None
            data_buffer = ""

            async for line in response.aiter_lines():
                if line.startswith("event: "):
                    current_event = line[7:].strip()
                    data_buffer = ""
                elif line.startswith("data: "):
                    data_buffer = line[6:]
                elif line == "" and current_event == "complete" and data_buffer:
                    try:
                        return json.loads(data_buffer)
                    except json.JSONDecodeError:
                        logger.warning("Failed to parse SSE data: %s", data_buffer[:200])
                        return []

            # If we get here without 'complete', check for errors
            if current_event == "error":
                logger.error("Space returned error: %s", data_buffer[:500])
            return []

    async def infer(self, image_data: bytes, call_params: list = None) -> Dict[str, Any]:
        """Full inference pipeline: upload → call → poll.

        Args:
            image_data: raw image bytes
            call_params: additional params for the Space function (passed to call())
        Returns dict with detections or cold_start status.
        """
        await self._maybe_keep_warm()

        try:
            file_path = await self.upload_file(image_data)
            event_id = await self.call(file_path, params=call_params)
            result = await self.poll_result(event_id)

            self._healthy = True
            return {
                "status": "ok",
                "detections": self._parse_yolo_result(result),
                "raw": result,
            }

        except httpx.HTTPStatusError as exc:
            # 5xx on cold start
            if 500 <= exc.response.status_code < 600:
                logger.info("Space %s cold starting (HTTP %d)", self.space_id, exc.response.status_code)
                return {"status": "cold_start", "retryAfterS": HF_COLD_START_TIMEOUT_S}
            raise

        except httpx.TimeoutException:
            logger.warning("Space %s timed out (cold start?)", self.space_id)
            return {"status": "cold_start", "retryAfterS": HF_COLD_START_TIMEOUT_S}

    async def health_check(self) -> bool:
        """Check if Space is reachable."""
        try:
            resp = await self._client.get("/", timeout=5.0)
            self._healthy = resp.status_code < 500
        except Exception:
            self._healthy = False
        return self._healthy

    async def keep_warm(self) -> None:
        """Wake up the Space by visiting the root page."""
        try:
            await self._client.get("/", timeout=10.0)
            self._last_keep_warm = time.monotonic()
        except Exception as exc:
            logger.debug("Keep-warm ping failed for %s: %s", self.space_id, exc)

    async def _maybe_keep_warm(self) -> None:
        """Ping Space if keep-warm interval has elapsed."""
        now = time.monotonic()
        if now - self._last_keep_warm > HF_KEEP_WARM_INTERVAL_S:
            # Don't await — fire and forget
            asyncio.create_task(self.keep_warm())

    def _parse_yolo_result(self, raw: List[Any]) -> List[Dict[str, Any]]:
        """Parse YOLO inference result into standard detection format.

        Space returns: [image_path, summary_text, detections_json]
        The third element (gr.JSON) contains structured detections.
        Falls back to parsing summary text if JSON is absent.
        """
        # Structured JSON from gr.JSON output (Space v2+)
        if isinstance(raw, list) and len(raw) >= 3 and isinstance(raw[2], list):
            detections = []
            for item in raw[2]:
                if not isinstance(item, dict):
                    continue
                cls_name = item.get("class", "unknown")
                confidence = item.get("confidence", 0.0)
                bbox_list = item.get("bbox", [])
                bbox = None
                if isinstance(bbox_list, list) and len(bbox_list) == 4:
                    bbox = {"x": bbox_list[0], "y": bbox_list[1],
                            "w": bbox_list[2] - bbox_list[0],
                            "h": bbox_list[3] - bbox_list[1]}
                detections.append({
                    "label": str(cls_name),
                    "confidence": float(confidence),
                    "bbox": bbox,
                })
            return detections

        # Fallback: parse old format (summary text)
        detections = []
        if not raw or not isinstance(raw, list):
            return detections

        for item in raw:
            if not isinstance(item, dict):
                continue

            label = item.get("label", "unknown")
            confidence = item.get("confidence", item.get("score", 0.0))

            # Bbox can be [xmin,ymin,xmax,ymax] or {xmin,ymin,xmax,ymax}
            bbox = item.get("box", item.get("bbox", None))
            if isinstance(bbox, list) and len(bbox) == 4:
                bbox = {"x": bbox[0], "y": bbox[1], "w": bbox[2] - bbox[0], "h": bbox[3] - bbox[1]}
            elif isinstance(bbox, dict):
                # Normalize keys
                bbox = {
                    "x": bbox.get("xmin", bbox.get("x", 0)),
                    "y": bbox.get("ymin", bbox.get("y", 0)),
                    "w": bbox.get("xmax", bbox.get("w", 0)) - bbox.get("xmin", bbox.get("x", 0)),
                    "h": bbox.get("ymax", bbox.get("h", 0)) - bbox.get("ymin", bbox.get("y", 0)),
                }

            detections.append({
                "label": str(label),
                "confidence": float(confidence),
                "bbox": bbox,
            })

        return detections

    def _parse_face_result(self, raw: List[Any]) -> List[Dict[str, Any]]:
        """Parse face embedding result into standard detection format.

        Face-embedder returns: [image_path, summary_text, face_data_json]
        face_data = [{index, bbox, confidence, landmarks, embedding(512D), embedding_dim, quality_score}]
        """
        if isinstance(raw, list) and len(raw) >= 3 and isinstance(raw[2], list):
            faces = []
            for fd in raw[2]:
                if not isinstance(fd, dict):
                    continue
                bbox_list = fd.get("bbox", [])
                bbox = None
                if isinstance(bbox_list, list) and len(bbox_list) == 4:
                    bbox = {"x": bbox_list[0], "y": bbox_list[1],
                            "w": bbox_list[2] - bbox_list[0],
                            "h": bbox_list[3] - bbox_list[1]}
                faces.append({
                    "label": "face",
                    "confidence": float(fd.get("confidence", 0)),
                    "bbox": bbox,
                    "embedding": fd.get("embedding"),       # 512D vector
                    "embedding_dim": fd.get("embedding_dim", 0),
                    "landmarks": fd.get("landmarks"),
                    "quality_score": fd.get("quality_score", 0),
                })
            return faces
        return []

    async def close(self) -> None:
        await self._client.aclose()


# ─── Space client pool ────────────────────────────────────────────────────

class HFSpacePool:
    """Pool of HF Space clients, lazily initialized."""

    def __init__(self):
        self._clients: Dict[str, HFSpaceClient] = {}
        self._last_keep_warm_all = 0.0

    def get(self, space_id: str, fn_name: str = "/predict") -> HFSpaceClient:
        if space_id not in self._clients:
            self._clients[space_id] = HFSpaceClient(space_id, fn_name)
        return self._clients[space_id]

    async def health_all(self) -> Dict[str, bool]:
        """Check health of all Spaces."""
        results = {}
        for sid, client in self._clients.items():
            results[sid] = await client.health_check()
        return results

    async def keep_warm_all(self) -> None:
        """Wake up all Spaces."""
        tasks = [client.keep_warm() for client in self._clients.values()]
        await asyncio.gather(*tasks, return_exceptions=True)
        self._last_keep_warm_all = time.monotonic()

    async def close_all(self) -> None:
        for client in self._clients.values():
            await client.close()
        self._clients.clear()


# ─── Global pool ───────────────────────────────────────────────────────────

_space_pool = HFSpacePool()


def get_space_pool() -> HFSpacePool:
    return _space_pool
