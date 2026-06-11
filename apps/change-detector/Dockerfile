FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/change-detector/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/change-detector/ ./change-detector/

ENV CHANGE_PORT=8085

EXPOSE 8085

CMD ["python", "-m", "uvicorn", "change-detector.app:app", "--host", "0.0.0.0", "--port", "8085"]
