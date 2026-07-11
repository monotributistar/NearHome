FROM alpine:3.19

RUN apk add --no-cache wireguard-tools curl bash iproute2

WORKDIR /app

COPY entrypoint.sh .

RUN chmod +x entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
