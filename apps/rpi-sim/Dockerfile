FROM alpine:3.19

RUN apk add --no-cache wireguard-tools curl bash iproute2 jq coreutils

WORKDIR /app

COPY apps/rpi-sim/entrypoint.sh .

RUN chmod +x entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
