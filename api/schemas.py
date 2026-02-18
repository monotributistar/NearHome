from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from enum import Enum


class IncidenceLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class IncidenceStatus(str, Enum):
    PENDING = "pending"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"
    FALSE_POSITIVE = "false_positive"


class ClientBase(BaseModel):
    name: str
    email: str
    phone: Optional[str] = None
    whatsapp: Optional[str] = None
    address: Optional[str] = None


class ClientCreate(ClientBase):
    storage_quota_mb: int = 10240


class ClientResponse(ClientBase):
    id: str
    is_active: bool
    storage_quota_mb: int
    storage_used_mb: int
    telegram_chat_id: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class CameraBase(BaseModel):
    name: str
    rtsp_url: str
    location: Optional[str] = None
    detect_persons: bool = True
    detect_vehicles: bool = True


class CameraCreate(CameraBase):
    client_id: str


class CameraResponse(CameraBase):
    id: str
    client_id: str
    is_active: bool
    is_recording: bool
    detection_enabled: bool
    shinobi_monitor_id: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class IncidenceCreate(BaseModel):
    client_id: str
    camera_id: str
    event_id: Optional[str] = None
    detection_type: str
    description: Optional[str] = None
    snapshot_path: Optional[str] = None
    level: IncidenceLevel = IncidenceLevel.LOW


class IncidenceResponse(BaseModel):
    id: str
    client_id: str
    camera_id: str
    event_id: Optional[str]
    level: IncidenceLevel
    status: IncidenceStatus
    detection_type: str
    description: Optional[str]
    snapshot_path: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class DetectionEventInput(BaseModel):
    event_id: str
    camera_id: str
    client_id: str
    timestamp: datetime
    detections: List[dict]
    detection_type: str
    frame_snapshot: Optional[str] = None
    metadata: Optional[dict] = None
