#!/usr/bin/env python3
"""
Generate synthetic test videos with known ground-truth for detection validation.

Creates MP4 files with moving objects (person, car) on a static background.
Each video has a JSON sidecar with per-frame bounding box ground-truth.

Usage:
  python3 scripts/pilot/generate-test-videos.py [--out /tmp/test-videos]
"""

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from typing import List, Tuple

import cv2
import numpy as np


@dataclass
class BBox:
    x: float  # center x (0-1 normalized)
    y: float  # center y (0-1 normalized)
    w: float  # width (0-1 normalized)
    h: float  # height (0-1 normalized)

    def to_dict(self):
        return {"x": self.x, "y": self.y, "w": self.w, "h": self.h}

    def to_pixels(self, frame_w: int, frame_h: int) -> Tuple[int, int, int, int]:
        x1 = int((self.x - self.w / 2) * frame_w)
        y1 = int((self.y - self.h / 2) * frame_h)
        x2 = int((self.x + self.w / 2) * frame_w)
        y2 = int((self.y + self.h / 2) * frame_h)
        return x1, y1, x2, y2


@dataclass
class MovingObject:
    label: str
    color: Tuple[int, int, int]  # BGR
    bbox: BBox
    speed_x: float = 0.0  # units per frame (normalized)
    speed_y: float = 0.0

    def step(self):
        self.bbox.x += self.speed_x
        self.bbox.y += self.speed_y
        # Clamp
        self.bbox.x = max(self.bbox.w / 2, min(1 - self.bbox.w / 2, self.bbox.x))
        self.bbox.y = max(self.bbox.h / 2, min(1 - self.bbox.h / 2, self.bbox.y))


@dataclass
class Scenario:
    name: str
    width: int
    height: int
    fps: int
    duration_s: int
    background_color: Tuple[int, int, int]
    objects: List[MovingObject] = field(default_factory=list)
    # Sequence of (start_frame, end_frame, callback) for dynamic behavior
    events: List = field(default_factory=list)

    @property
    def total_frames(self):
        return self.fps * self.duration_s


def create_entrance_scenario() -> Scenario:
    """Person enters from bottom-left, walks to center, exits right."""
    s = Scenario(
        name="entrance",
        width=640,
        height=480,
        fps=15,
        duration_s=30,
        background_color=(200, 220, 200),  # light green-gray
    )
    # Person (red) starts at bottom-left, moves to center, then right
    person = MovingObject(
        label="person",
        color=(0, 0, 255),  # red in BGR
        bbox=BBox(x=0.15, y=0.85, w=0.08, h=0.25),  # bottom-left
        speed_x=0.004,  # slow rightward
        speed_y=-0.006,  # upward
    )
    s.objects.append(person)
    # After frame 150 (10s), change direction to exit right
    s.events.append((150, lambda: setattr(person, "speed_x", 0.008)))
    s.events.append((150, lambda: setattr(person, "speed_y", 0.0)))
    return s


def create_parking_scenario() -> Scenario:
    """Car enters from right, parks, person exits car."""
    s = Scenario(
        name="parking",
        width=640,
        height=480,
        fps=15,
        duration_s=30,
        background_color=(180, 180, 200),  # blue-gray (parking lot)
    )
    # Car (blue) enters from right
    car = MovingObject(
        label="car",
        color=(255, 0, 0),  # blue in BGR
        bbox=BBox(x=0.90, y=0.60, w=0.15, h=0.12),  # right side
        speed_x=-0.006,  # moves left
        speed_y=0.0,
    )
    s.objects.append(car)
    # After frame 120 (8s), car stops
    s.events.append((120, lambda: setattr(car, "speed_x", 0.0)))
    # After frame 150 (10s), person emerges from car
    s.events.append((150, lambda: s.objects.append(MovingObject(
        label="person",
        color=(0, 0, 255),
        bbox=BBox(x=car.bbox.x, y=car.bbox.y - 0.08, w=0.06, h=0.20),
        speed_x=0.003,
        speed_y=-0.002,
    ))))
    return s


def create_perimeter_scenario() -> Scenario:
    """Person walks along edges of the frame."""
    s = Scenario(
        name="perimeter",
        width=640,
        height=480,
        fps=15,
        duration_s=30,
        background_color=(200, 200, 180),
    )
    # Person starts top-left, walks right along top, down right, left along bottom
    person = MovingObject(
        label="person",
        color=(0, 0, 255),
        bbox=BBox(x=0.10, y=0.08, w=0.07, h=0.22),
        speed_x=0.005,
        speed_y=0.0,
    )
    s.objects.append(person)
    # Turn down at right edge
    s.events.append((120, lambda: setattr(person, "speed_x", 0.0)))
    s.events.append((120, lambda: setattr(person, "speed_y", 0.004)))
    # Turn left at bottom
    s.events.append((240, lambda: setattr(person, "speed_y", 0.0)))
    s.events.append((240, lambda: setattr(person, "speed_x", -0.005)))
    return s


def create_empty_scenario() -> Scenario:
    """Static scene with no motion — tests false positives."""
    s = Scenario(
        name="empty",
        width=640,
        height=480,
        fps=15,
        duration_s=15,
        background_color=(200, 210, 200),
    )
    # No objects
    return s


def create_night_scenario() -> Scenario:
    """Dark scene where motion detection is harder — tests low-light performance."""
    s = Scenario(
        name="night",
        width=640,
        height=480,
        fps=15,
        duration_s=20,
        background_color=(30, 35, 40),  # dark
    )
    # Person barely visible, walks slowly
    person = MovingObject(
        label="person",
        color=(0, 0, 80),  # dark red
        bbox=BBox(x=0.30, y=0.70, w=0.06, h=0.20),
        speed_x=0.002,
        speed_y=-0.002,
    )
    s.objects.append(person)
    return s


def generate_video(scenario: Scenario, output_dir: str):
    """Generate MP4 video file and ground-truth JSON."""
    os.makedirs(output_dir, exist_ok=True)

    video_path = os.path.join(output_dir, f"{scenario.name}.mp4")
    json_path = os.path.join(output_dir, f"{scenario.name}.json")

    fourcc = cv2.VideoWriter_fourcc(*"avc1")  # H.264
    out = cv2.VideoWriter(video_path, fourcc, scenario.fps, (scenario.width, scenario.height))

    ground_truth = {
        "scenario": scenario.name,
        "width": scenario.width,
        "height": scenario.height,
        "fps": scenario.fps,
        "duration_s": scenario.duration_s,
        "total_frames": scenario.total_frames,
        "frames": [],
    }

    bg = np.full(
        (scenario.height, scenario.width, 3),
        scenario.background_color,
        dtype=np.uint8,
    )

    # Add some texture to background
    cv2.rectangle(bg, (50, 50), (590, 430), (180, 200, 180), 2)  # border
    cv2.rectangle(bg, (200, 300), (440, 420), (160, 180, 160), -1)  # building
    cv2.line(bg, (0, 400), (640, 400), (100, 100, 100), 1)  # horizon

    print(f"  Generating {scenario.name}: {scenario.total_frames} frames, {scenario.duration_s}s")

    for frame_idx in range(scenario.total_frames):
        frame = bg.copy()

        # Process events
        for trigger_frame, callback in scenario.events:
            if frame_idx == trigger_frame:
                callback()

        # Draw timestamp
        ts = frame_idx / scenario.fps
        cv2.putText(
            frame,
            f"t={ts:.1f}s | {scenario.name}",
            (10, 25),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            1,
        )

        # Draw objects
        frame_objects = []
        for obj in scenario.objects:
            obj.step()
            x1, y1, x2, y2 = obj.bbox.to_pixels(scenario.width, scenario.height)
            cv2.rectangle(frame, (x1, y1), (x2, y2), obj.color, 2)
            cv2.putText(
                frame,
                obj.label,
                (x1, y1 - 5),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.4,
                obj.color,
                1,
            )
            frame_objects.append({
                "label": obj.label,
                "bbox": obj.bbox.to_dict(),
                "frame": frame_idx,
                "timestamp_s": round(ts, 2),
            })

        out.write(frame)
        ground_truth["frames"].append({
            "frame": frame_idx,
            "timestamp_s": round(ts, 2),
            "objects": frame_objects,
        })

    out.release()

    with open(json_path, "w") as f:
        json.dump(ground_truth, f, indent=2)

    file_size = os.path.getsize(video_path) / 1024
    print(f"    → {video_path} ({file_size:.0f} KB)")
    print(f"    → {json_path}")


def main():
    parser = argparse.ArgumentParser(description="Generate synthetic test videos")
    parser.add_argument("--out", default="/tmp/nearhome-test-videos", help="Output directory")
    args = parser.parse_args()

    scenarios = [
        create_entrance_scenario(),
        create_parking_scenario(),
        create_perimeter_scenario(),
        create_empty_scenario(),
        create_night_scenario(),
    ]

    print(f"Generating {len(scenarios)} test videos in {args.out}/\n")

    for scenario in scenarios:
        generate_video(scenario, args.out)

    # Summary
    print(f"\nDone. {len(scenarios)} videos generated.")
    print(f"  Directory: {args.out}/")
    for s in scenarios:
        print(f"  {s.name}.mp4 — {s.duration_s}s, {len(s.objects)} objects, {s.total_frames} frames")


if __name__ == "__main__":
    main()
