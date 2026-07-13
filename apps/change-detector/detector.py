"""Core MOG2 motion detection for RTSP frames.

Reads raw BGR frames from ffmpeg pipe, applies background subtraction,
returns motion decision + JPEG-encoded frame.

Usage:
    from detector import MotionDetector
    det = MotionDetector(threshold=0.05, history=500)
    has_motion, pct, jpeg = det.process(frame_bgr)
"""

from __future__ import annotations

import io
import os
import time
from typing import Optional, Tuple

import cv2
import numpy as np


class MotionDetector:
    """OpenCV MOG2 background subtraction motion detector."""

    def __init__(
        self,
        threshold: float = 0.05,
        history: int = 500,
        var_threshold: int = 36,
        width: int = 640,
        height: int = 480,
        warmup_frames: int = 30,
    ):
        self.threshold = threshold
        self.width = width
        self.height = height
        self.warmup_frames = warmup_frames

        self._bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=history,
            varThreshold=var_threshold,
            detectShadows=False,
        )
        self._frame_count = 0
        self._last_motion_time = -999.0  # allow first motion immediately
        self._motion_cooldown_s = float(
            os.environ.get("CHANGE_MOTION_COOLDOWN_S", "1.0")
        )

    @property
    def is_warmed_up(self) -> bool:
        return self._frame_count >= self.warmup_frames

    def process(self, frame_bgr: np.ndarray) -> Tuple[bool, float, Optional[bytes]]:
        """Process a raw BGR frame.

        Returns (has_motion, motion_pct, jpeg_bytes_or_None).
        """
        self._frame_count += 1

        if frame_bgr.shape[:2] != (self.height, self.width):
            frame_bgr = cv2.resize(frame_bgr, (self.width, self.height))

        fg_mask = self._bg_subtractor.apply(frame_bgr)
        total_pixels = fg_mask.size
        fg_pixels = np.count_nonzero(fg_mask)
        motion_pct = fg_pixels / total_pixels

        has_motion = motion_pct >= self.threshold

        # Cooldown: don't fire more than once per cooldown period
        if has_motion:
            now = time.monotonic()
            if now - self._last_motion_time < self._motion_cooldown_s:
                has_motion = False
            else:
                self._last_motion_time = now

        jpeg = None
        if has_motion:
            _, jpeg = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])
            jpeg = jpeg.tobytes()

        return has_motion, motion_pct, jpeg

    def process_with_zone_mask(
        self, frame_bgr: np.ndarray, zone_mask: Optional[np.ndarray] = None
    ) -> Tuple[bool, float, Optional[bytes]]:
        """Process with an optional zone mask (0=ignore, 255=analyze)."""
        if zone_mask is not None:
            if zone_mask.shape[:2] != frame_bgr.shape[:2]:
                zone_mask = cv2.resize(zone_mask, (frame_bgr.shape[1], frame_bgr.shape[0]))
            frame_bgr = cv2.bitwise_and(frame_bgr, frame_bgr, mask=zone_mask)

        return self.process(frame_bgr)

    def reset(self) -> None:
        """Reset background model (useful on camera reconnect)."""
        self._bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=500, varThreshold=36, detectShadows=False
        )
        self._frame_count = 0
        self._last_motion_time = -999.0
