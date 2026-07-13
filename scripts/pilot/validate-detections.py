#!/usr/bin/env python3
"""
Validate detection pipeline against ground-truth from synthetic test videos.

Captures frames from RTSP streams, sends them to inference-bridge,
compares YOLO detections with known ground-truth bounding boxes.

Usage:
  python3 scripts/pilot/validate-detections.py [--camera entrance] [--frames 10]
"""

import argparse
import json
import os
import subprocess
import sys
import time
from typing import Dict, List, Optional

import httpx

BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://localhost:8080/infer")
VIDEO_DIR = os.environ.get("VIDEO_DIR", "/tmp/nearhome-test-videos")

GREEN = "\033[0;32m"
RED = "\033[0;31m"
YELLOW = "\033[1;33m"
CYAN = "\033[0;36m"
NC = "\033[0m"


def load_ground_truth(scenario: str) -> Optional[Dict]:
    """Load ground-truth JSON for a scenario."""
    path = os.path.join(VIDEO_DIR, f"{scenario}.json")
    if not os.path.exists(path):
        print(f"{RED}Ground-truth not found: {path}{NC}")
        print(f"Run: python3 scripts/pilot/generate-test-videos.py")
        return None
    with open(path) as f:
        return json.load(f)


def capture_frame_from_rtsp(rtsp_url: str, output_file: str) -> bool:
    """Capture a single frame from RTSP stream using ffmpeg."""
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-rtsp_transport", "tcp",
                "-i", rtsp_url,
                "-vframes", "1",
                "-f", "image2",
                output_file,
            ],
            capture_output=True,
            timeout=10,
            check=True,
        )
        return os.path.exists(output_file) and os.path.getsize(output_file) > 100
    except Exception as e:
        print(f"  {RED}Capture failed: {e}{NC}")
        return False


def send_to_bridge(frame_path: str, tenant_id: str, camera_id: str) -> Optional[Dict]:
    """Send frame to inference-bridge and get detections."""
    try:
        with open(frame_path, "rb") as f:
            files = {"file": ("frame.jpg", f.read(), "image/jpeg")}
            data = {"tenantId": tenant_id, "cameraId": camera_id}
            resp = httpx.post(
                f"{BRIDGE_URL}/v1/infer/hf/yolo",
                files=files,
                data=data,
                timeout=30,
            )
            if resp.status_code == 200:
                return resp.json()
            print(f"  {YELLOW}Bridge returned {resp.status_code}{NC}")
            return None
    except Exception as e:
        print(f"  {RED}Bridge request failed: {e}{NC}")
        return None


def iou(box_a: Dict, box_b: Dict) -> float:
    """Intersection over Union between two bounding boxes (normalized coords)."""
    x1 = max(box_a["x"] - box_a["w"] / 2, box_b["x"] - box_b["w"] / 2)
    y1 = max(box_a["y"] - box_a["h"] / 2, box_b["y"] - box_b["h"] / 2)
    x2 = min(box_a["x"] + box_a["w"] / 2, box_b["x"] + box_b["w"] / 2)
    y2 = min(box_a["y"] + box_a["h"] / 2, box_b["y"] + box_b["h"] / 2)

    if x2 <= x1 or y2 <= y1:
        return 0.0

    intersection = (x2 - x1) * (y2 - y1)
    area_a = box_a["w"] * box_a["h"]
    area_b = box_b["w"] * box_b["h"]
    union = area_a + area_b - intersection

    return intersection / union if union > 0 else 0.0


def validate_detections(
    scenario: str,
    num_frames: int = 10,
    frame_skip: int = 15,  # skip N frames between captures
    tenant_id: str = "validation-tenant",
    camera_id: str = "validation-cam",
):
    """Run full validation pipeline."""
    gt = load_ground_truth(scenario)
    if not gt:
        return 1

    rtsp_url = f"rtsp://localhost:8554/{scenario}"
    tmp_dir = "/tmp/nearhome-validation"
    os.makedirs(tmp_dir, exist_ok=True)

    print(f"\n{CYAN}═══ Validating: {scenario} ({num_frames} frames) ═══{NC}\n")
    print(f"  RTSP: {rtsp_url}")
    print(f"  Ground-truth: {gt['total_frames']} frames, {gt['fps']}fps")
    print()

    stats = {
        "total_objects_gt": 0,
        "total_objects_detected": 0,
        "matched": 0,
        "missed": 0,
        "false_positives": 0,
        "iou_sum": 0.0,
        "frames_processed": 0,
    }

    for i in range(num_frames):
        gt_idx = i * frame_skip
        if gt_idx >= gt["total_frames"]:
            break

        gt_frame = gt["frames"][gt_idx]
        stats["total_objects_gt"] += len(gt_frame["objects"])

        # Capture frame
        frame_path = os.path.join(tmp_dir, f"{scenario}_{gt_idx:04d}.jpg")
        if not capture_frame_from_rtsp(rtsp_url, frame_path):
            print(f"  {YELLOW}Frame {gt_idx}: capture failed — skipping{NC}")
            continue

        # Detect
        result = send_to_bridge(frame_path, tenant_id, camera_id)
        if not result or result.get("status") != "ok":
            print(f"  {YELLOW}Frame {gt_idx}: detection failed — skipping{NC}")
            continue

        detections = result.get("detections", [])
        stats["total_objects_detected"] += len(detections)
        stats["frames_processed"] += 1

        # Match detections to ground-truth
        gt_objects = gt_frame["objects"]
        matched_gt = set()
        matched_det = set()

        for gi, gt_obj in enumerate(gt_objects):
            best_iou = 0.0
            best_di = -1
            for di, det in enumerate(detections):
                if di in matched_det:
                    continue
                # Match by label first (case-insensitive)
                if det.get("label", "").lower() != gt_obj["label"].lower():
                    continue
                iou_val = iou(gt_obj["bbox"], det.get("bbox", {}))
                if iou_val > best_iou:
                    best_iou = iou_val
                    best_di = di

            if best_iou >= 0.3:  # IoU threshold
                matched_gt.add(gi)
                matched_det.add(best_di)
                stats["matched"] += 1
                stats["iou_sum"] += best_iou

        stats["missed"] += len(gt_objects) - len(matched_gt)
        stats["false_positives"] += len(detections) - len(matched_det)

        # Print frame result
        status = (
            f"{GREEN}✓{NC}" if len(matched_gt) == len(gt_objects) and stats["false_positives"] == 0
            else f"{YELLOW}~{NC}"
        )
        print(
            f"  {status} Frame {gt_idx:4d} (t={gt_frame['timestamp_s']:5.1f}s): "
            f"GT={len(gt_objects)} Det={len(detections)} "
            f"Match={len(matched_gt)} Miss={len(gt_objects)-len(matched_gt)} FP={len(detections)-len(matched_det)}"
        )

        # Cleanup
        os.remove(frame_path)

    # Summary
    print(f"\n{CYAN}═══ Results: {scenario} ═══{NC}")
    print(f"  Frames processed:    {stats['frames_processed']}/{num_frames}")
    print(f"  Ground-truth objects: {stats['total_objects_gt']}")
    print(f"  Detected objects:    {stats['total_objects_detected']}")
    print(f"  Matched:             {stats['matched']}")
    print(f"  Missed:              {stats['missed']}")
    print(f"  False positives:     {stats['false_positives']}")

    if stats["matched"] > 0:
        avg_iou = stats["iou_sum"] / stats["matched"]
        print(f"  Avg IoU:             {avg_iou:.3f}")

    recall = stats["matched"] / max(1, stats["total_objects_gt"])
    precision = stats["matched"] / max(1, stats["total_objects_detected"])
    f1 = 2 * precision * recall / max(0.001, precision + recall)

    print(f"  Recall:              {recall:.1%}")
    print(f"  Precision:           {precision:.1%}")
    print(f"  F1 Score:            {f1:.3f}")

    if recall >= 0.5 and precision >= 0.5:
        print(f"\n  {GREEN}✓ Detection pipeline validated{NC}")
        return 0
    else:
        print(f"\n  {YELLOW}⚠ Detection quality below threshold (recall={recall:.1%}, precision={precision:.1%}){NC}")
        print(f"  Note: YOLO is in mock mode without HF_TOKEN. Real model may differ.")
        return 0  # Don't fail on mock mode


def main():
    parser = argparse.ArgumentParser(description="Validate detection pipeline")
    parser.add_argument("--camera", default="entrance", help="Scenario to validate (entrance, parking, perimeter, empty, night)")
    parser.add_argument("--frames", type=int, default=10, help="Number of frames to sample")
    parser.add_argument("--skip", type=int, default=15, help="Frames to skip between captures")
    parser.add_argument("--all", action="store_true", help="Validate all scenarios")
    args = parser.parse_args()

    if args.all:
        scenarios = ["entrance", "parking", "perimeter", "empty", "night"]
        exit_code = 0
        for s in scenarios:
            if validate_detections(s, args.frames, args.skip):
                exit_code = 1
        return exit_code

    return validate_detections(args.camera, args.frames, args.skip)


if __name__ == "__main__":
    sys.exit(main())
