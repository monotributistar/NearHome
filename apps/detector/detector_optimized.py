async def create_detection_in_db(detections: list, frame_url: str,
                                  tenant_id: str, camera_id: str, ts: str):
    """Batch store all detections via API (fire-and-forget)."""
    if not JWT_TOKEN or not detections:
        return

    payload = {
        "tenantId": tenant_id,
        "cameraId": camera_id,
        "observations": [{
            "label": d["label"],
            "confidence": d["confidence"],
            "bbox": d["bbox"],
        } for d in detections[:20]],
        "frameUrl": frame_url,
        "frameTimestamp": ts,
    }

    try:
        async with httpx.AsyncClient(base_url=API_URL, timeout=10) as client:
            r = await client.post(
                "/internal/detections/observations/batch",
                json=payload,
                headers={
                    "Authorization": f"Bearer {JWT_TOKEN}",
                    "X-Tenant-Id": tenant_id,
                }
            )
            if r.status_code not in (200, 201):
                print(f"  DB batch store: {r.status_code}")
            else:
                data = r.json()
                print(f"  DB stored: {data.get('count',0)} observations")
    except Exception as e:
        print(f"  DB batch error: {e}")


async def publish_event(detections: list, frame_url: str, frame_w: int, frame_h: int,
                         tenant_id: str, camera_id: str, ts: str):
    """Publish single batch event with all detections (fire-and-forget)."""
    if not detections:
        return

    event = {
        "eventType": "detection.object",
        "tenantId": tenant_id,
        "cameraId": camera_id,
        "payload": {
            "detections": [{
                "label": d["label"],
                "confidence": d["confidence"],
                "bbox": d["bbox"],
            } for d in detections[:5]],
            "frameWidth": frame_w,
            "frameHeight": frame_h,
            "frameUrl": frame_url,
            "frameTimestamp": ts,
        },
        "occurredAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    try:
        async with httpx.AsyncClient(base_url=EVENT_URL, timeout=5) as client:
            await client.post(
                "/internal/events/publish",
                json=event,
                headers={"x-event-publish-secret": EVENT_SECRET}
            )
    except:
        pass