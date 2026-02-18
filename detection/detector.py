import cv2
import numpy as np
import base64
from ultralytics import YOLO
from typing import List, Tuple, Optional
import logging

from models import Detection, BoundingBox, DetectionType
from config import (
    MODEL_NAME,
    CONFIDENCE_THRESHOLD,
    PERSON_CLASSES,
    VEHICLE_CLASSES,
    CLASS_NAMES,
    DETECTION_TARGETS,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class YOLODetector:
    def __init__(self, model_name: str = MODEL_NAME):
        self.model = YOLO(model_name)
        self.confidence_threshold = CONFIDENCE_THRESHOLD
        logger.info(f"YOLO model loaded: {model_name}")

    def decode_frame(self, frame_base64: str) -> np.ndarray:
        frame_bytes = base64.b64decode(frame_base64)
        nparr = np.frombuffer(frame_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        return frame

    def classify_detection(self, class_id: int) -> DetectionType:
        if class_id in PERSON_CLASSES:
            return DetectionType.PERSON
        elif class_id in VEHICLE_CLASSES:
            return DetectionType.VEHICLE
        return DetectionType.UNKNOWN

    def detect(
        self, frame_base64: str, targets: List[str] = None
    ) -> Tuple[List[Detection], Optional[DetectionType], Optional[np.ndarray]]:
        if targets is None:
            targets = DETECTION_TARGETS

        frame = self.decode_frame(frame_base64)
        if frame is None:
            logger.error("Failed to decode frame")
            return [], None, None

        results = self.model(frame, verbose=False)

        detections = []
        primary_type = None

        for result in results:
            boxes = result.boxes
            if boxes is None:
                continue

            for box in boxes:
                class_id = int(box.cls[0])
                confidence = float(box.conf[0])

                class_name = CLASS_NAMES.get(class_id, f"class_{class_id}")

                if class_name not in targets:
                    continue

                if confidence < self.confidence_threshold:
                    continue

                x1, y1, x2, y2 = box.xyxy[0].tolist()

                detection = Detection(
                    class_name=class_name,
                    class_id=class_id,
                    confidence=round(confidence, 3),
                    bbox=BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2),
                )

                detections.append(detection)

                det_type = self.classify_detection(class_id)
                if primary_type is None or det_type == DetectionType.PERSON:
                    primary_type = det_type

        return detections, primary_type, frame

    def annotate_frame(
        self, frame: np.ndarray, detections: List[Detection]
    ) -> np.ndarray:
        annotated = frame.copy()

        for det in detections:
            bbox = det.bbox
            color = (0, 255, 0) if det.class_name == "person" else (255, 0, 0)

            cv2.rectangle(
                annotated,
                (int(bbox.x1), int(bbox.y1)),
                (int(bbox.x2), int(bbox.y2)),
                color,
                2,
            )

            label = f"{det.class_name} {det.confidence:.2f}"
            cv2.putText(
                annotated,
                label,
                (int(bbox.x1), int(bbox.y1) - 10),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                color,
                2,
            )

        return annotated

    def encode_frame(self, frame: np.ndarray) -> str:
        _, buffer = cv2.imencode(".jpg", frame)
        return base64.b64encode(buffer).decode("utf-8")
