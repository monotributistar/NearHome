FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg && \
    rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir ultralytics requests opencv-python-headless

COPY apps/frame-grabber/frame-grabber.py .

CMD ["python3", "frame-grabber.py"]
