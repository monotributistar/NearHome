FROM alpine:3.19

RUN apk add --no-cache \
    ffmpeg \
    python3 \
    curl \
    bash

# Install MediaMTX
ARG MEDIAMTX_VERSION=1.9.3
ARG TARGETARCH
RUN ARCH=$(case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) echo "amd64" ;; \
      arm64|aarch64) echo "arm64v8" ;; \
      *) echo "amd64" ;; \
    esac) && \
    curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${ARCH}.tar.gz" \
    | tar xz -C /usr/local/bin mediamtx

WORKDIR /app
COPY mediamtx.yml /app/mediamtx.yml
COPY onvif_responder.py /app/onvif_responder.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV CAMERA_ID=01
ENV CAMERA_MANUFACTURER=GenericCam
ENV CAMERA_MODEL=MockIPCam-1000
ENV CAMERA_SERIAL=MOCK-000001
ENV CAMERA_FIRMWARE=1.0.0
ENV RTSP_PORT=554
ENV ONVIF_PORT=80
ENV STREAM_FPS=1
ENV STREAM_RESOLUTION=640x480

EXPOSE 554 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD curl -sf http://localhost:${ONVIF_PORT}/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
