FROM python:3.12-alpine

RUN apk add --no-cache gcc musl-dev linux-headers

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bulb_simulator.py .

ENV BULB_ID=01
ENV BULB_NAME="Mock Light 01"
ENV BULB_MANUFACTURER=NearHome
ENV BULB_MODEL=NHB-100
ENV BULB_FIRMWARE=1.0.0
ENV MQTT_BROKER=
ENV HTTP_PORT=80

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s \
  CMD wget -qO- http://localhost:${HTTP_PORT}/health || exit 1

CMD ["python", "-u", "bulb_simulator.py"]
