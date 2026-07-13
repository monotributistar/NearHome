FROM nvidia/cuda:12.5.0-runtime-ubuntu22.04

RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    python3 python3-pip build-essential libgl1 libglib2.0-0 libgomp1 && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/inference-node-face/requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt
COPY apps/inference-node-face/app.py .
EXPOSE 8094
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8094"]
