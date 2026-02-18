from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from enum import Enum


class DetectionType(str, Enum):
    PERSON = "person"
    VEHICLE = "vehicle"
    UNKNOWN = "unknown"


class BoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


class Detection(BaseModel):
    class_name: str
    class_id: int
    confidence: float
    bbox: BoundingBox


class FrameInput(BaseModel):
    camera_id: str
    client_id: str
    timestamp: datetime
    frame_data: str
    width: int
    height: int


class DetectionEvent(BaseModel):
    event_id: str
    camera_id: str
    client_id: str
    timestamp: datetime
    detections: List[Detection]
    detection_type: DetectionType
    frame_snapshot: Optional[str] = None
    metadata: Optional[dict] = None
