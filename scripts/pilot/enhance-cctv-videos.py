#!/usr/bin/env python3
"""Generate enhanced CCTV videos with real person overlays."""
import cv2, numpy as np, json, os, urllib.request

DIR = "/tmp/nearhome-real-videos"
OBJECTS_DIR = f"{DIR}/objects"
os.makedirs(OBJECTS_DIR, exist_ok=True)

# Download person template
person_url = "https://ultralytics.com/images/zidane.jpg"
person_path = f"{OBJECTS_DIR}/person1.jpg"
if not os.path.exists(person_path) or os.path.getsize(person_path) < 1000:
    print(f"Downloading person template...")
    urllib.request.urlretrieve(person_url, person_path)
    print(f"  {os.path.getsize(person_path)//1024}KB")

# Car template from bus image
car_path = f"{OBJECTS_DIR}/bus.jpg"
if not os.path.exists(car_path) or os.path.getsize(car_path) < 1000:
    print(f"Downloading car template...")
    urllib.request.urlretrieve("https://ultralytics.com/images/bus.jpg", car_path)
    print(f"  {os.path.getsize(car_path)//1024}KB")

# Load templates
person_img = cv2.imread(person_path)
if person_img is not None:
    person_img = cv2.resize(person_img, (35, 80))

car_img = cv2.imread(car_path)
if car_img is not None:
    car_img = cv2.resize(car_img, (80, 40))

FPS, DUR, W, H = 15, 30, 640, 480
TOTAL = FPS * DUR

scenarios = [
    {
        "name": "office-v2",
        "desc": "Office entrance — people walking",
        "bg": (50, 45, 40),
        "objects": [
            {"label": "person", "x": 100, "y": 250, "vx": 1.5, "vy": 0, "template": person_img},
            {"label": "person", "x": 500, "y": 270, "vx": -1.8, "vy": 0, "template": person_img},
        ]
    },
    {
        "name": "parking-v2", 
        "desc": "Parking lot — cars and pedestrian",
        "bg": (80, 75, 70),
        "objects": [
            {"label": "car", "x": 120, "y": 330, "vx": 1.2, "vy": 0, "template": car_img},
            {"label": "person", "x": 350, "y": 290, "vx": 0.8, "vy": 0, "template": person_img},
        ]
    },
    {
        "name": "street-v2",
        "desc": "Street crossing",
        "bg": (90, 85, 80),
        "objects": [
            {"label": "person", "x": 60, "y": 250, "vx": 2.0, "vy": 0, "template": person_img},
            {"label": "car", "x": 520, "y": 360, "vx": -2.5, "vy": 0, "template": car_img},
        ]
    },
]

for sc in scenarios:
    print(f"\n{sc['name']}: {sc['desc']}")
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(f"{DIR}/{sc['name']}.mp4", fourcc, FPS, (W, H))
    gt = {"scenario": sc['name'], "desc": sc['desc'], "fps": FPS, "frames": []}
    
    bg = np.full((H, W, 3), sc['bg'], dtype=np.uint8)
    cv2.line(bg, (0, H//2), (W, H//2), tuple(c//2 for c in sc['bg']), 1)
    
    for fn in range(TOTAL):
        frame = bg.copy()
        dets = []
        
        for obj in sc['objects']:
            obj["x"] += obj["vx"]; obj["y"] += obj["vy"]
            if obj["x"] < -80: obj["x"] = W + 80
            if obj["x"] > W + 80: obj["x"] = -80
            
            tpl = obj.get("template")
            if tpl is not None:
                th, tw = tpl.shape[:2]
                x, y = int(obj["x"]) - tw//2, int(obj["y"]) - th//2
                x = max(0, min(x, W - tw))
                y = max(0, min(y, H - th))
                roi = frame[y:y+th, x:x+tw]
                if roi.shape == tpl.shape:
                    roi[:] = tpl
                dets.append({"label": obj["label"], "bbox": [x, y, x+tw, y+th]})
            else:
                cv2.ellipse(frame, (int(obj["x"]), int(obj["y"])+25), (10,28), 0,0,360, (200,200,255), -1)
                cv2.circle(frame, (int(obj["x"]), int(obj["y"])), 12, (200,200,255), -1)
                dets.append({"label": "person", "bbox": [int(obj["x"])-14, int(obj["y"])-5, int(obj["x"])+14, int(obj["y"])+70]})
        
        # CCTV overlay
        secs = fn / FPS
        ts = f"2026-06-18 {int(secs//3600):02d}:{int((secs%3600)//60):02d}:{int(secs%60):02d}"
        cv2.putText(frame, ts, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255,255,255), 1)
        cv2.putText(frame, "CAM-01", (W-100, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255,255,255), 1)
        noise = np.random.randint(0, 12, frame.shape, dtype=np.uint8)
        frame = cv2.addWeighted(frame, 0.93, noise, 0.07, 0)
        _, enc = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 72])
        frame = cv2.imdecode(enc, 1)
        
        writer.write(frame)
        if fn % 15 == 0:
            gt["frames"].append({"frame": fn, "time_s": round(fn/FPS,2), "objects": dets})
    
    writer.release()
    with open(f"{DIR}/{sc['name']}.json", "w") as f:
        json.dump(gt, f, indent=2)
    video_path = f"{DIR}/{sc['name']}.mp4"
    print(f"  {os.path.getsize(video_path)/1024/1024:.1f}MB, {len(gt['frames'])} ground-truth entries")

print("\nDone! Videos with real person/car photo overlays for YOLO detection.")
