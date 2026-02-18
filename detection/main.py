import uuid
import json
import logging
from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
import redis

from models import FrameInput, DetectionEvent, Detection
from detector import YOLODetector
from config import (
    REDIS_HOST,
    REDIS_PORT,
    REDIS_DB,
    API_BASE_URL,
    EVENT_QUEUE_KEY,
    DETECTION_TARGETS,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="NearHome YOLO Detector", version="1.0.0")

detector = YOLODetector()

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
    return {"status": "healthy", "service": "yolo-detector"}


@app.post("/detect", response_model=DetectionEvent)
async def detect_objects(frame_input: FrameInput):
    try:
        detections, detection_type, frame = detector.detect(
            frame_input.frame_data, DETECTION_TARGETS
        )

        if not detections:
            return JSONResponse(
                status_code=200,
                content={"message": "No detections", "camera_id": frame_input.camera_id},
            )

        annotated_frame = detector.annotate_frame(frame, detections)
        frame_snapshot = detector.encode_frame(annotated_frame)

        event = DetectionEvent(
            event_id=str(uuid.uuid4()),
            camera_id=frame_input.camera_id,
            client_id=frame_input.client_id,
            timestamp=datetime.utcnow(),
            detections=detections,
            detection_type=detection_type,
            frame_snapshot=frame_snapshot,
            metadata={
                "frame_width": frame_input.width,
                "frame_height": frame_input.height,
            },
        )

        if redis_client:
            event_data = event.model_dump_json()
            redis_client.lpush(EVENT_QUEUE_KEY, event_data)
            logger.info(f"Event queued: {event.event_id}")

        logger.info(
            f"Detected {len(detections)} objects on camera {frame_input.camera_id}: "
            f"{[d.class_name for d in detections]}"
        )

        return event

    except Exception as e:
        logger.error(f"Detection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/detect/batch")
async def detect_batch(frames: list[FrameInput]):
    results = []
    for frame in frames:
        try:
            detections, detection_type, _ = detector.detect(frame.frame_data)
            results.append(
                {
                    "camera_id": frame.camera_id,
                    "detections_count": len(detections),
                    "detection_type": detection_type.value if detection_type else None,
                }
            )
        except Exception as e:
            results.append({"camera_id": frame.camera_id, "error": str(e)})

    return {"results": results}
