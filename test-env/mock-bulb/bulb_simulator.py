#!/usr/bin/env python3
"""
Mock smart lightbulb simulator.
Exposes HTTP REST API + MQTT state publishing + mDNS advertisement.
"""

import json
import logging
import os
import socket
import struct
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")
logger = logging.getLogger("mock-bulb")

# Configuration from environment
BULB_ID = os.environ.get("BULB_ID", "01")
BULB_NAME = os.environ.get("BULB_NAME", f"Mock Light {BULB_ID}")
MANUFACTURER = os.environ.get("BULB_MANUFACTURER", "NearHome")
MODEL = os.environ.get("BULB_MODEL", "NHB-100")
FIRMWARE = os.environ.get("BULB_FIRMWARE", "1.0.0")
MQTT_BROKER = os.environ.get("MQTT_BROKER", "").strip()
HTTP_PORT = int(os.environ.get("HTTP_PORT", "80"))

# Generate a deterministic MAC from bulb ID
BULB_MAC = f"02:42:ac:1e:01:{int(BULB_ID):02x}"


class BulbState:
    """Thread-safe bulb state manager."""

    def __init__(self):
        self._lock = threading.Lock()
        self._state = {
            "on": False,
            "brightness": 100,
            "color_temp": 4000,
            "rgb": [255, 255, 255],
        }
        self._on_change = None

    def get(self) -> dict:
        with self._lock:
            return dict(self._state)

    def update(self, patch: dict) -> dict:
        with self._lock:
            for key in ("on", "brightness", "color_temp", "rgb"):
                if key in patch:
                    self._state[key] = patch[key]
            state = dict(self._state)

        if self._on_change:
            self._on_change(state)
        return state

    def set_on_change(self, callback):
        self._on_change = callback


bulb_state = BulbState()


# --------------- HTTP REST API ---------------

class BulbHTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        logger.debug(f"HTTP: {fmt % args}")

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"status": "ok", "bulb_id": BULB_ID})
        elif self.path == "/state":
            self._send_json(bulb_state.get())
        elif self.path == "/info":
            self._send_json({
                "bulb_id": BULB_ID,
                "name": BULB_NAME,
                "manufacturer": MANUFACTURER,
                "model": MODEL,
                "firmware": FIRMWARE,
                "mac": BULB_MAC,
                "capabilities": ["on_off", "brightness", "color_temp", "rgb"],
                "deviceType": "light",
            })
        else:
            self.send_error(404)

    def do_PUT(self):
        if self.path == "/state":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                patch = json.loads(body)
                new_state = bulb_state.update(patch)
                logger.info(f"State updated: {new_state}")
                self._send_json(new_state)
            except (json.JSONDecodeError, ValueError) as e:
                self._send_json({"error": str(e)}, 400)
        else:
            self.send_error(404)


def run_http_server():
    server = HTTPServer(("0.0.0.0", HTTP_PORT), BulbHTTPHandler)
    logger.info(f"HTTP server listening on :{HTTP_PORT}")
    server.serve_forever()


# --------------- MQTT ---------------

def run_mqtt_client():
    if not MQTT_BROKER:
        logger.info("No MQTT_BROKER configured, skipping MQTT")
        return

    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        logger.warning("paho-mqtt not installed, skipping MQTT")
        return

    state_topic = f"nearhome/lights/{BULB_ID}/state"
    set_topic = f"nearhome/lights/{BULB_ID}/set"

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"mock-bulb-{BULB_ID}")

    def on_connect(client, userdata, flags, reason_code, properties):
        logger.info(f"MQTT connected to {MQTT_BROKER} (rc={reason_code})")
        client.subscribe(set_topic)
        # Publish initial state
        client.publish(state_topic, json.dumps(bulb_state.get()), retain=True)

    def on_message(client, userdata, msg):
        try:
            patch = json.loads(msg.payload)
            new_state = bulb_state.update(patch)
            client.publish(state_topic, json.dumps(new_state), retain=True)
            logger.info(f"MQTT command received, new state: {new_state}")
        except Exception as e:
            logger.error(f"MQTT message error: {e}")

    def on_state_change(state):
        client.publish(state_topic, json.dumps(state), retain=True)

    bulb_state.set_on_change(on_state_change)

    client.on_connect = on_connect
    client.on_message = on_message

    # Retry connection
    while True:
        try:
            client.connect(MQTT_BROKER, 1883, 60)
            break
        except Exception as e:
            logger.warning(f"MQTT connection failed ({e}), retrying in 3s...")
            time.sleep(3)

    client.loop_forever()


# --------------- mDNS ---------------

def run_mdns_advertisement():
    try:
        from zeroconf import Zeroconf, ServiceInfo
    except ImportError:
        logger.warning("zeroconf not installed, skipping mDNS")
        return

    # Get our own IP
    local_ip = _get_local_ip()
    if not local_ip:
        logger.warning("Cannot determine local IP, skipping mDNS")
        return

    info = ServiceInfo(
        type_="_nearhome-light._tcp.local.",
        name=f"NearHome Light {BULB_ID}._nearhome-light._tcp.local.",
        addresses=[socket.inet_aton(local_ip)],
        port=HTTP_PORT,
        properties={
            "deviceType": "light",
            "manufacturer": MANUFACTURER,
            "model": MODEL,
            "mac": BULB_MAC,
            "bulbId": BULB_ID,
        },
        server=f"mock-bulb-{BULB_ID}.local.",
    )

    zc = Zeroconf()
    zc.register_service(info)
    logger.info(f"mDNS registered: _nearhome-light._tcp @ {local_ip}:{HTTP_PORT}")

    # Keep running until process exits
    try:
        while True:
            time.sleep(60)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        zc.unregister_service(info)
        zc.close()


def _get_local_ip() -> str:
    """Get the container's local IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return ""


# --------------- Main ---------------

def main():
    logger.info(f"Starting mock bulb {BULB_ID} ({BULB_NAME})")
    logger.info(f"  Manufacturer: {MANUFACTURER}, Model: {MODEL}")
    logger.info(f"  MAC: {BULB_MAC}")
    logger.info(f"  HTTP: :{HTTP_PORT}, MQTT broker: {MQTT_BROKER or '(none)'}")

    threads = [
        threading.Thread(target=run_http_server, daemon=True),
        threading.Thread(target=run_mqtt_client, daemon=True),
        threading.Thread(target=run_mdns_advertisement, daemon=True),
    ]

    for t in threads:
        t.start()

    # Block on HTTP server thread (non-daemon would also work)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("Shutting down mock bulb")


if __name__ == "__main__":
    main()
