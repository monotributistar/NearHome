FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir \
    ultralytics \
    fastapi \
    uvicorn \
    python-multipart \
    requests \
    httpx \
    aiofiles \
    Pillow

COPY apps/detector/app.py .
COPY apps/frame-grabber/frame-grabber.py ./frame-grabber.py

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
