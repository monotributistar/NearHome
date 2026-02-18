CLASS_NAMES = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}

PERSON_CLASSES = [0]
VEHICLE_CLASSES = [2, 3, 5, 7]

DETECTION_TARGETS = ["person", "car", "motorcycle", "bus", "truck"]

MODEL_NAME = "yolov8n.pt"

CONFIDENCE_THRESHOLD = 0.5

REDIS_HOST = "redis"
REDIS_PORT = 6379
REDIS_DB = 0

API_BASE_URL = "http://api:8000"

FRAME_QUEUE_KEY = "nearhome:frames:queue"
EVENT_QUEUE_KEY = "nearhome:events:queue"
