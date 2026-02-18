from sqlalchemy import Column, String, Boolean, DateTime, Integer, ForeignKey, Text, Enum
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import enum

from database import Base


class IncidenceLevel(enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class IncidenceStatus(enum.Enum):
    PENDING = "pending"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"
    FALSE_POSITIVE = "false_positive"


class Client(Base):
    __tablename__ = "clients"

    id = Column(String(36), primary_key=True)
    name = Column(String(100), nullable=False)
    email = Column(String(100), unique=True, nullable=False)
    phone = Column(String(20))
    whatsapp = Column(String(20))
    telegram_chat_id = Column(String(50))
    address = Column(String(255))
    is_active = Column(Boolean, default=True)
    storage_quota_mb = Column(Integer, default=10240)
    storage_used_mb = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    cameras = relationship("Camera", back_populates="client")
    incidences = relationship("Incidence", back_populates="client")


class Camera(Base):
    __tablename__ = "cameras"

    id = Column(String(36), primary_key=True)
    client_id = Column(String(36), ForeignKey("clients.id"), nullable=False)
    name = Column(String(100), nullable=False)
    rtsp_url = Column(String(255), nullable=False)
    location = Column(String(100))
    is_active = Column(Boolean, default=True)
    is_recording = Column(Boolean, default=False)
    detection_enabled = Column(Boolean, default=True)
    detect_persons = Column(Boolean, default=True)
    detect_vehicles = Column(Boolean, default=True)
    shinobi_monitor_id = Column(String(50))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    client = relationship("Client", back_populates="cameras")
    incidences = relationship("Incidence", back_populates="camera")


class Incidence(Base):
    __tablename__ = "incidences"

    id = Column(String(36), primary_key=True)
    client_id = Column(String(36), ForeignKey("clients.id"), nullable=False)
    camera_id = Column(String(36), ForeignKey("cameras.id"), nullable=False)
    event_id = Column(String(36))
    level = Column(Enum(IncidenceLevel), default=IncidenceLevel.LOW)
    status = Column(Enum(IncidenceStatus), default=IncidenceStatus.PENDING)
    detection_type = Column(String(50))
    description = Column(Text)
    snapshot_path = Column(String(255))
    video_clip_path = Column(String(255))
    acknowledged_by = Column(String(36))
    acknowledged_at = Column(DateTime)
    resolved_at = Column(DateTime)
    notes = Column(Text)
    created_at = Column(DateTime, server_default=func.now())

    client = relationship("Client", back_populates="incidences")
    camera = relationship("Camera", back_populates="incidences")
