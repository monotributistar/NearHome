"""Unit tests for motion detector using synthetic frames."""

import numpy as np
import pytest

from detector import MotionDetector


def _make_frame(width=640, height=480, color=(128, 128, 128)):
    """Create a solid-color BGR frame."""
    return np.full((height, width, 3), color, dtype=np.uint8)


def test_detector_initialization():
    det = MotionDetector(width=320, height=240)
    assert not det.is_warmed_up
    assert det.threshold == 0.05


def test_detector_warmup():
    det = MotionDetector(width=320, height=240, warmup_frames=5)

    # Feed 5 static frames
    frame = _make_frame(320, 240)
    for _ in range(5):
        has_motion, _, _ = det.process(frame)

    assert det.is_warmed_up


def test_static_scene_no_motion():
    det = MotionDetector(width=320, height=240, warmup_frames=30)

    # Warm up with static frames
    frame = _make_frame(320, 240)
    for _ in range(30):
        det.process(frame)

    # After warmup, static scene should not trigger
    has_motion, motion_pct, jpeg = det.process(frame)
    assert not has_motion
    assert motion_pct < 0.05
    assert jpeg is None


def test_motion_detection():
    det = MotionDetector(width=320, height=240, warmup_frames=60, threshold=0.05)

    # Warm up with many static frames
    static = _make_frame(320, 240, (128, 128, 128))
    for _ in range(60):
        det.process(static)

    # Inject a drastically different frame
    motion_frame = _make_frame(320, 240, (255, 0, 0))
    has_motion, motion_pct, jpeg = det.process(motion_frame)

    assert has_motion, f"Motion not detected (pct={motion_pct:.4f})"
    assert motion_pct > 0.05, f"Motion too low: {motion_pct:.4f}"
    assert jpeg is not None
    assert len(jpeg) > 100


def test_cooldown():
    det = MotionDetector(width=320, height=240, warmup_frames=60, threshold=0.05)
    # Override cooldown for test
    det._motion_cooldown_s = 999.0

    static = _make_frame(320, 240, (128, 128, 128))
    for _ in range(60):
        det.process(static)

    motion_frame = _make_frame(320, 240, (255, 0, 0))

    # First motion should trigger
    has_motion, _, jpeg = det.process(motion_frame)
    assert has_motion, "First motion should trigger"
    assert jpeg is not None

    # Second motion within cooldown should NOT trigger
    has_motion2, _, jpeg2 = det.process(motion_frame)
    assert not has_motion2, "Second motion within cooldown should be suppressed"
    assert jpeg2 is None


def test_reset():
    det = MotionDetector(width=320, height=240, warmup_frames=30)
    static = _make_frame(320, 240)
    for _ in range(35):
        det.process(static)

    assert det.is_warmed_up
    det.reset()
    assert not det.is_warmed_up


def test_zone_mask_ignores_motion():
    """Motion in masked zone should be ignored."""
    det = MotionDetector(width=160, height=120, warmup_frames=20, threshold=0.1)

    static = _make_frame(160, 120, (128, 128, 128))
    for _ in range(20):
        det.process(static)

    # Full-frame mask set to 0 (ignore everything)
    mask = np.zeros((120, 160), dtype=np.uint8)

    motion_frame = _make_frame(160, 120, (255, 0, 0))
    has_motion, _, _ = det.process_with_zone_mask(motion_frame, mask)

    assert not has_motion
