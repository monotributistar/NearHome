"""ffmpeg pipe → MOG2 detector → HTTP forwarder pipeline.

Reads RTSP via ffmpeg subprocess, detects motion, POSTs JPEG frames
to inference-bridge when motion is detected.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from typing import Optional

import httpx
import numpy as np

from .detector import MotionDetector

logger = logging.getLogger("change-detector.pipeline")


class Pipeline:
    """RTSP → detection → HTTP forward pipeline."""

    def __init__(
        self,
        rtsp_url: str,
        tenant_id: str,
        camera_id: str,
        inference_url: str = "http://localhost:8090/v1/infer/hf/yolo",
        frame_width: int = 640,
        frame_height: int = 480,
        frame_skip: int = 3,
        motion_threshold: float = 0.05,
    ):
        self.rtsp_url = rtsp_url
        self.tenant_id = tenant_id
        self.camera_id = camera_id
        self.inference_url = inference_url
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.frame_skip = max(1, frame_skip)

        self.detector = MotionDetector(
            threshold=motion_threshold, width=frame_width, height=frame_height
        )
        self._ffmpeg: Optional[subprocess.Popen] = None
        self._running = False
        self._frame_idx = 0
        self._motion_frames = 0
        self._total_frames = 0
        self._client = httpx.Client(timeout=30.0)

    def start(self) -> None:
        """Launch ffmpeg subprocess and begin processing loop."""
        self._running = True
        self._start_ffmpeg()

        try:
            self._loop()
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def _start_ffmpeg(self) -> None:
        """Spawn ffmpeg subprocess reading RTSP as raw BGR frames."""
        cmd = [
            "ffmpeg",
            "-rtsp_transport", "tcp",
            "-i", self.rtsp_url,
            "-f", "rawvideo",
            "-pix_fmt", "bgr24",
            "-vcodec", "rawvideo",
            "-an",  # no audio
            "-",
        ]
        logger.info("ffmpeg: %s", " ".join(cmd))
        self._ffmpeg = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )

    def _read_frame(self) -> Optional[np.ndarray]:
        """Read one raw BGR frame from ffmpeg stdout."""
        frame_size = self.frame_width * self.frame_height * 3
        try:
            raw = self._ffmpeg.stdout.read(frame_size)  # type: ignore[union-attr]
        except (BrokenPipeError, OSError):
            return None
        if not raw or len(raw) < frame_size:
            return None
        return np.frombuffer(raw, dtype=np.uint8).reshape(
            self.frame_height, self.frame_width, 3
        )

    def _loop(self) -> None:
        """Main processing loop."""
        logger.info("Pipeline started: tenant=%s camera=%s", self.tenant_id, self.camera_id)

        while self._running:
            frame = self._read_frame()
            if frame is None:
                logger.warning("ffmpeg pipe closed, restarting...")
                self._restart_ffmpeg()
                self.detector.reset()
                time.sleep(2)
                continue

            self._total_frames += 1
            self._frame_idx += 1

            if self._frame_idx % self.frame_skip != 0:
                continue

            has_motion, motion_pct, jpeg = self.detector.process(frame)

            if has_motion and jpeg:
                self._motion_frames += 1
                self._forward_frame(jpeg, motion_pct)

    def _forward_frame(self, jpeg: bytes, motion_pct: float) -> None:
        """POST JPEG frame + metadata to inference-bridge."""
        try:
            resp = self._client.post(
                self.inference_url,
                files={"file": ("frame.jpg", jpeg, "image/jpeg")},
                data={
                    "tenantId": self.tenant_id,
                    "cameraId": self.camera_id,
                    "frameTs": str(int(time.time() * 1000)),
                    "motionPct": f"{motion_pct:.4f}",
                },
            )
            if resp.status_code >= 400:
                logger.warning(
                    "Inference bridge returned %d: %s",
                    resp.status_code,
                    resp.text[:200],
                )
        except httpx.RequestError as exc:
            logger.warning("Failed to forward frame: %s", exc)

    def _restart_ffmpeg(self) -> None:
        """Restart ffmpeg subprocess after connection loss."""
        if self._ffmpeg:
            try:
                self._ffmpeg.stdout.close()
                self._ffmpeg.terminate()
                self._ffmpeg.wait(timeout=5)
            except Exception:
                self._ffmpeg.kill()
        self._start_ffmpeg()

    def stop(self) -> None:
        """Gracefully stop pipeline."""
        self._running = False
        if self._ffmpeg:
            try:
                self._ffmpeg.stdout.close()
                self._ffmpeg.terminate()
                self._ffmpeg.wait(timeout=5)
            except Exception:
                self._ffmpeg.kill()
        self._client.close()
        logger.info(
            "Pipeline stopped: %d frames, %d motion, %.2f%%",
            self._total_frames,
            self._motion_frames,
            100 * self._motion_frames / max(1, self._total_frames),
        )

    @property
    def status(self) -> dict:
        return {
            "running": self._running,
            "rtspUrl": self.rtsp_url,
            "tenantId": self.tenant_id,
            "cameraId": self.camera_id,
            "totalFrames": self._total_frames,
            "motionFrames": self._motion_frames,
            "detectorWarmedUp": self.detector.is_warmed_up,
        }
