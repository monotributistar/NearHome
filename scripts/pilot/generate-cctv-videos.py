#!/usr/bin/env python3
"""Generate realistic security camera videos with ground-truth JSON.

Creates 5 scenarios mimicking real CCTV footage:
  1. office-entrance: people entering/leaving through door
  2. parking-lot: cars parking + people walking
  3. street-crossing: pedestrians crossing street
  4. corridor: mostly empty, occasional person passing
  5. loading-dock: truck + workers moving boxes

Each video: 30s, 15fps, 640x480, grainy CCTV look + timestamp overlay.
Ground-truth JSON sidecar with per-frame bounding boxes.
"""

import cv2
import numpy as np
import json
import os
from dataclasses import dataclass
from typing import List, Tuple

OUT_DIR = "/tmp/nearhome-real-videos"
FPS = 15
DURATION_S = 30
W, H = 640, 480
TOTAL_FRAMES = FPS * DURATION_S

os.makedirs(OUT_DIR, exist_ok=True)


@dataclass
class Object:
    label: str
    x: float
    y: float
    w: int
    h: int
    vx: float
    vy: float
    color: tuple


def draw_cctv_overlay(frame, frame_num, fps):
    """Draw timestamp and camera label like real CCTV."""
    seconds = frame_num / fps
    ts = f"2026-06-18 {int(seconds//3600):02d}:{int((seconds%3600)//60):02d}:{int(seconds%60):02d}"
    # Timestamp top-left
    cv2.putText(frame, ts, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    # Camera label top-right
    cv2.putText(frame, "CAM-01", (W - 100, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    # Add subtle noise for CCTV grain
    noise = np.random.randint(0, 15, frame.shape, dtype=np.uint8)
    frame = cv2.addWeighted(frame, 0.92, noise, 0.08, 0)
    return frame


def draw_person(frame, x, y, color=(200, 200, 255)):
    """Draw a simple person silhouette (ellipse body + circle head)."""
    # Body
    cv2.ellipse(frame, (int(x), int(y + 25)), (10, 28), 0, 0, 360, color, -1)
    # Head
    cv2.circle(frame, (int(x), int(y)), 12, color, -1)
    # Legs
    cv2.line(frame, (int(x - 5), int(y + 50)), (int(x - 8), int(y + 65)), color, 3)
    cv2.line(frame, (int(x + 5), int(y + 50)), (int(x + 8), int(y + 65)), color, 3)
    bbox = (x - 14, y - 5, 28, 75)  # (x, y, w, h) of bounding box
    return bbox


def draw_car(frame, x, y, color=(100, 100, 255)):
    """Draw a simple car shape top-down."""
    # Body
    cv2.rectangle(frame, (int(x - 25), int(y - 10)), (int(x + 25), int(y + 10)), color, -1)
    # Roof
    cv2.rectangle(frame, (int(x - 12), int(y - 8)), (int(x + 12), int(y + 2)), (color[0]//2, color[1]//2, color[2]//2), -1)
    # Windows
    cv2.rectangle(frame, (int(x - 10), int(y - 7)), (int(x - 2), int(y)), (180, 220, 255), -1)
    cv2.rectangle(frame, (int(x + 2), int(y - 7)), (int(x + 10), int(y)), (180, 220, 255), -1)
    bbox = (x - 28, y - 15, 56, 32)
    return bbox


def draw_truck(frame, x, y, color=(80, 80, 200)):
    """Draw a truck/van shape."""
    # Cargo body
    cv2.rectangle(frame, (int(x - 15), int(y - 20)), (int(x + 30), int(y + 15)), color, -1)
    # Cab
    cv2.rectangle(frame, (int(x - 25), int(y - 10)), (int(x - 15), int(y + 5)), (color[0]//2, color[1]//2, color[2]//2), -1)
    bbox = (x - 28, y - 25, 60, 45)
    return bbox


def draw_box(frame, x, y, color=(100, 150, 200)):
    """Draw a small box/cargo."""
    cv2.rectangle(frame, (int(x - 8), int(y - 5)), (int(x + 8), int(y + 5)), color, -1)
    bbox = (x - 10, y - 8, 20, 16)
    return bbox


def generate_scenario(name, background_color, objects_generator, description):
    """Generate one CCTV scenario video + ground-truth JSON."""
    print(f"\n{'='*60}")
    print(f"Generating: {name} — {description}")
    print(f"{'='*60}")
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    path = f"{OUT_DIR}/{name}.mp4"
    writer = cv2.VideoWriter(path, fourcc, FPS, (W, H))
    
    ground_truth = {
        "scenario": name,
        "description": description,
        "fps": FPS,
        "duration_s": DURATION_S,
        "resolution": [W, H],
        "frames": []
    }
    
    # Background
    bg = np.full((H, W, 3), background_color, dtype=np.uint8)
    # Add some texture (floor lines, walls)
    cv2.line(bg, (0, H//2), (W, H//2), (background_color[0]//2, background_color[1]//2, background_color[2]//2), 1)
    
    objects = objects_generator()
    
    for fn in range(TOTAL_FRAMES):
        frame = bg.copy()
        frame_detections = []
        
        # Update and draw each object
        for obj in objects:
            obj.x += obj.vx
            obj.y += obj.vy
            
            # Wrap around edges
            if obj.x < -50: obj.x = W + 50
            if obj.x > W + 50: obj.x = -50
            if obj.y < -50: obj.y = H + 50
            if obj.y > H + 50: obj.y = -50
            
            # Draw based on label
            bbox = None
            if obj.label == "person":
                bbox = draw_person(frame, obj.x, obj.y, obj.color)
            elif obj.label == "car":
                bbox = draw_car(frame, obj.x, obj.y, obj.color)
            elif obj.label == "truck":
                bbox = draw_truck(frame, obj.x, obj.y, obj.color)
            elif obj.label == "box":
                bbox = draw_box(frame, obj.x, obj.y, obj.color)
            
            if bbox:
                x, y, w, h = bbox
                frame_detections.append({
                    "label": obj.label,
                    "bbox": [round(x), round(y), round(x + w), round(y + h)],
                    "center": [round(obj.x), round(obj.y)]
                })
        
        frame = draw_cctv_overlay(frame, fn, FPS)
        
        # Slight compression artifacts (CCTV look)
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 75]
        _, encoded = cv2.imencode('.jpg', frame, encode_param)
        frame = cv2.imdecode(encoded, 1)
        
        writer.write(frame)
        
        if fn % 15 == 0:  # Every second
            ground_truth["frames"].append({
                "frame": fn,
                "time_s": round(fn / FPS, 2),
                "objects": frame_detections
            })
    
    writer.release()
    
    # Write ground-truth
    with open(f"{OUT_DIR}/{name}.json", "w") as f:
        json.dump(ground_truth, f, indent=2)
    
    size_mb = os.path.getsize(path) / (1024*1024)
    print(f"  Done: {size_mb:.1f}MB, {TOTAL_FRAMES} frames, {len(ground_truth['frames'])} ground-truth entries")


# ─── Scenario 1: Office Entrance ────────────────────────────────────

def office_objects():
    return [
        Object("person", 100, 240, 12, 75, 1.5, 0, (200, 200, 255)),
        Object("person", 300, 300, 12, 75, -1.2, 0, (200, 255, 200)),
        Object("person", 500, 260, 12, 75, -1.8, 0, (255, 200, 200)),
    ]

generate_scenario("office-entrance", (60, 55, 50),
                  office_objects,
                  "Office entrance — 3 people entering/leaving door area")


# ─── Scenario 2: Parking Lot ────────────────────────────────────────

def parking_objects():
    return [
        Object("car", 150, 300, 56, 32, 1.0, 0, (100, 100, 255)),
        Object("car", 500, 350, 56, 32, -1.3, 0, (255, 150, 100)),
        Object("person", 350, 280, 12, 75, 0.8, 0, (200, 200, 255)),
    ]

generate_scenario("parking-lot", (80, 75, 70),
                  parking_objects,
                  "Parking lot — 2 cars + 1 person walking between cars")


# ─── Scenario 3: Street Crossing ────────────────────────────────────

def street_objects():
    return [
        Object("person", 50, 240, 12, 75, 2.0, 0, (200, 200, 255)),
        Object("person", 500, 260, 12, 75, -1.5, 0, (200, 255, 200)),
        Object("car", 100, 350, 56, 32, 2.5, 0, (100, 100, 255)),
        Object("car", 550, 370, 56, 32, -2.0, 0, (255, 150, 100)),
    ]

generate_scenario("street-crossing", (90, 85, 80),
                  street_objects,
                  "Street crossing — 2 pedestrians + 2 cars crossing paths")


# ─── Scenario 4: Empty Corridor ─────────────────────────────────────

def corridor_objects():
    # Single person, enters frame at random times
    return [
        Object("person", -100, 260, 12, 75, 1.5, 0, (200, 200, 255)),
    ]

generate_scenario("corridor", (50, 50, 55),
                  corridor_objects,
                  "Empty corridor — mostly static, occasional person passing through")


# ─── Scenario 5: Loading Dock ───────────────────────────────────────

def dock_objects():
    return [
        Object("truck", 200, 240, 60, 45, 0.3, 0, (80, 80, 200)),
        Object("person", 400, 260, 12, 75, -0.8, 0, (200, 200, 255)),
        Object("person", 500, 280, 12, 75, -0.5, 0, (200, 255, 200)),
        Object("box", 450, 240, 20, 16, -0.4, 0, (100, 150, 200)),
    ]

generate_scenario("loading-dock", (70, 65, 60),
                  dock_objects,
                  "Loading dock — truck + 2 workers moving boxes")


print(f"\n{'='*60}")
print(f"All videos generated in {OUT_DIR}/")
print(f"{'='*60}")
for f in sorted(os.listdir(OUT_DIR)):
    if f.endswith('.mp4'):
        size_mb = os.path.getsize(f"{OUT_DIR}/{f}") / (1024*1024)
        print(f"  {f}: {size_mb:.1f}MB")
