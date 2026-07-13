FROM alpine:3.20

RUN apk add --no-cache \
  bash \
  iproute2 \
  iptables \
  wireguard-tools

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
