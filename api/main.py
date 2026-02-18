import uuid
import json
import logging
import threading
from datetime import datetime
from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import redis

from database import engine, Base, get_db
from models import Client, Camera, Incidence, IncidenceLevel, IncidenceStatus
from schemas import (
    ClientCreate,
    ClientResponse,
    CameraCreate,
    CameraResponse,
    IncidenceCreate,
    IncidenceResponse,
    DetectionEventInput,
)
from config import REDIS_HOST, REDIS_PORT, REDIS_DB, EVENT_QUEUE_KEY

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="NearHome API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

try:
    redis_client = redis.Redis(
        host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB, decode_responses=True
    )
    redis_client.ping()
    logger.info("Redis connected")
except Exception as e:
    logger.warning(f"Redis not available: {e}")
    redis_client = None


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "nearhome-api"}


@app.post("/clients", response_model=ClientResponse)
async def create_client(client: ClientCreate, db: Session = Depends(get_db)):
    db_client = Client(
        id=str(uuid.uuid4()),
        name=client.name,
        email=client.email,
        phone=client.phone,
        whatsapp=client.whatsapp,
        address=client.address,
        storage_quota_mb=client.storage_quota_mb,
    )
    db.add(db_client)
    db.commit()
    db.refresh(db_client)
    logger.info(f"Client created: {db_client.id}")
    return db_client


@app.get("/clients", response_model=list[ClientResponse])
async def list_clients(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    return db.query(Client).offset(skip).limit(limit).all()


@app.get("/clients/{client_id}", response_model=ClientResponse)
async def get_client(client_id: str, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    return client


@app.post("/cameras", response_model=CameraResponse)
async def create_camera(camera: CameraCreate, db: Session = Depends(get_db)):
    client = db.query(Client).filter(Client.id == camera.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    db_camera = Camera(
        id=str(uuid.uuid4()),
        client_id=camera.client_id,
        name=camera.name,
        rtsp_url=camera.rtsp_url,
        location=camera.location,
        detect_persons=camera.detect_persons,
        detect_vehicles=camera.detect_vehicles,
    )
    db.add(db_camera)
    db.commit()
    db.refresh(db_camera)
    logger.info(f"Camera created: {db_camera.id}")
    return db_camera


@app.get("/cameras", response_model=list[CameraResponse])
async def list_cameras(
    client_id: str = None, skip: int = 0, limit: int = 100, db: Session = Depends(get_db)
):
    query = db.query(Camera)
    if client_id:
        query = query.filter(Camera.client_id == client_id)
    return query.offset(skip).limit(limit).all()


@app.get("/cameras/{camera_id}", response_model=CameraResponse)
async def get_camera(camera_id: str, db: Session = Depends(get_db)):
    camera = db.query(Camera).filter(Camera.id == camera_id).first()
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")
    return camera


@app.post("/incidences", response_model=IncidenceResponse)
async def create_incidence(
    incidence: IncidenceCreate, db: Session = Depends(get_db)
):
    client = db.query(Client).filter(Client.id == incidence.client_id).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    camera = db.query(Camera).filter(Camera.id == incidence.camera_id).first()
    if not camera:
        raise HTTPException(status_code=404, detail="Camera not found")

    db_incidence = Incidence(
        id=str(uuid.uuid4()),
        client_id=incidence.client_id,
        camera_id=incidence.camera_id,
        event_id=incidence.event_id,
        level=IncidenceLevel(incidence.level.value),
        detection_type=incidence.detection_type,
        description=incidence.description,
        snapshot_path=incidence.snapshot_path,
    )
    db.add(db_incidence)
    db.commit()
    db.refresh(db_incidence)
    logger.info(f"Incidence created: {db_incidence.id}")
    return db_incidence


@app.get("/incidences", response_model=list[IncidenceResponse])
async def list_incidences(
    client_id: str = None,
    camera_id: str = None,
    status: str = None,
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
):
    query = db.query(Incidence)
    if client_id:
        query = query.filter(Incidence.client_id == client_id)
    if camera_id:
        query = query.filter(Incidence.camera_id == camera_id)
    if status:
        query = query.filter(Incidence.status == IncidenceStatus(status))
    return query.order_by(Incidence.created_at.desc()).offset(skip).limit(limit).all()


@app.post("/events/detection")
async def process_detection_event(
    event: DetectionEventInput, background_tasks: BackgroundTasks, db: Session = Depends(get_db)
):
    camera = db.query(Camera).filter(Camera.id == event.camera_id).first()
    if not camera:
        logger.warning(f"Camera not found: {event.camera_id}")
        return {"status": "ignored", "reason": "camera_not_found"}

    if not camera.detection_enabled:
        return {"status": "ignored", "reason": "detection_disabled"}

    detection_types = [d.get("class_name") for d in event.detections]

    level = IncidenceLevel.LOW
    if "person" in detection_types:
        level = IncidenceLevel.HIGH
    elif any(v in detection_types for v in ["car", "motorcycle", "bus", "truck"]):
        level = IncidenceLevel.MEDIUM

    description = f"Detected: {', '.join(detection_types)}"

    incidence = Incidence(
        id=str(uuid.uuid4()),
        client_id=event.client_id,
        camera_id=event.camera_id,
        event_id=event.event_id,
        level=level,
        detection_type=event.detection_type,
        description=description,
    )

    db.add(incidence)
    db.commit()

    logger.info(f"Incidence created from detection: {incidence.id} - {description}")

    return {
        "status": "created",
        "incidence_id": incidence.id,
        "level": level.value,
    }


def event_worker():
    if not redis_client:
        return

    logger.info("Event worker started")
    while True:
        try:
            _, event_data = redis_client.brpop(EVENT_QUEUE_KEY, timeout=5)
            event = json.loads(event_data)
            logger.info(f"Processing event: {event.get('event_id')}")

        except redis.exceptions.ConnectionError:
            logger.error("Redis connection lost")
            break
        except Exception as e:
            logger.error(f"Event worker error: {e}")


@app.on_event("startup")
async def startup_event():
    if redis_client:
        worker_thread = threading.Thread(target=event_worker, daemon=True)
        worker_thread.start()
