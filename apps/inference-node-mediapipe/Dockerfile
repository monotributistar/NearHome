FROM python:3.11-slim

WORKDIR /app

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    libgl1 libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/*

COPY apps/inference-node-mediapipe/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/inference-node-mediapipe/app.py .

EXPOSE 8092

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8092"]
