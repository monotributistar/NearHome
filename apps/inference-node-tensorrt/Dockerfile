FROM nvidia/cuda:12.5.0-runtime-ubuntu22.04

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    python3 python3-pip libgl1 libglib2.0-0 libxcb1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/inference-node-tensorrt/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download model
RUN python3 -c "from ultralytics import YOLO; YOLO('yolo11n.pt')"

COPY apps/inference-node-tensorrt/app.py .

EXPOSE 8093

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8093"]
