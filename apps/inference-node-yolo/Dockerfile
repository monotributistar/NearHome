FROM python:3.11-slim

WORKDIR /app

# OpenCV runtime dependencies
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    libgl1 libglib2.0-0 libxcb1 && \
    rm -rf /var/lib/apt/lists/*

COPY apps/inference-node-yolo/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/inference-node-yolo/app.py .

EXPOSE 8091

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091"]
