#!/usr/bin/env python3
"""
Generate a docker-compose.generated.yml with N mock cameras and M mock bulbs.
Usage: python generate-compose.py [--cameras N] [--bulbs M]
"""

import argparse
import yaml


CAMERA_MANUFACTURERS = [
    ("Hikvision", "DS-2CD2043G2-I", "5.7.20"),
    ("Dahua", "IPC-HDW5442T-ZE", "2.830.0"),
    ("Reolink", "RLC-810A", "3.1.0"),
    ("Axis", "M3115-LVE", "11.6.54"),
    ("Amcrest", "IP8M-T2599E", "2.620.00"),
    ("TP-Link", "Tapo C320WS", "1.3.0"),
    ("Uniview", "IPC3614SB-ADF28KM", "4.1.0"),
    ("Hanwha", "XNO-6080R", "2.21.00"),
]

BULB_MODELS = [
    ("NearHome", "NHB-100", "Living Room Light"),
    ("NearHome", "NHB-200-RGB", "Bedroom Light"),
    ("NearHome", "NHB-100", "Kitchen Light"),
    ("NearHome", "NHB-300-WARM", "Hallway Light"),
    ("NearHome", "NHB-200-RGB", "Bathroom Light"),
    ("NearHome", "NHB-100", "Garage Light"),
]


def generate(camera_count: int, bulb_count: int) -> dict:
    services = {}

    # Mosquitto
    services["mosquitto"] = {
        "image": "eclipse-mosquitto:2",
        "command": "mosquitto -c /dev/null -p 1883 -v",
        "networks": {
            "iot_lan": {"ipv4_address": "172.30.0.2"}
        },
    }

    # Mock cameras
    for i in range(1, camera_count + 1):
        mfg = CAMERA_MANUFACTURERS[(i - 1) % len(CAMERA_MANUFACTURERS)]
        ip_last = 10 + (i - 1)
        mac_last = f"{ip_last:02x}"
        services[f"mock-camera-{i}"] = {
            "build": "./mock-camera",
            "environment": {
                "CAMERA_ID": f"{i:02d}",
                "CAMERA_MANUFACTURER": mfg[0],
                "CAMERA_MODEL": mfg[1],
                "CAMERA_SERIAL": f"MOCK-{mfg[0][:3].upper()}-{i:03d}",
                "CAMERA_FIRMWARE": mfg[2],
                "STREAM_RESOLUTION": "640x480",
                "STREAM_FPS": "1",
            },
            "mac_address": f"02:42:ac:1e:00:{mac_last}",
            "networks": {
                "iot_lan": {"ipv4_address": f"172.30.0.{ip_last}"}
            },
        }

    # Mock bulbs
    for i in range(1, bulb_count + 1):
        model = BULB_MODELS[(i - 1) % len(BULB_MODELS)]
        ip_last = 20 + (i - 1)
        services[f"mock-bulb-{i}"] = {
            "build": "./mock-bulb",
            "environment": {
                "BULB_ID": f"{i:02d}",
                "BULB_NAME": model[2],
                "BULB_MANUFACTURER": model[0],
                "BULB_MODEL": model[1],
                "MQTT_BROKER": "mosquitto",
            },
            "mac_address": f"02:42:ac:1e:01:{i:02x}",
            "depends_on": ["mosquitto"],
            "networks": {
                "iot_lan": {"ipv4_address": f"172.30.0.{ip_last}"}
            },
        }

    # Discovery agent
    camera_deps = [f"mock-camera-{i}" for i in range(1, camera_count + 1)]
    bulb_deps = [f"mock-bulb-{i}" for i in range(1, bulb_count + 1)]
    services["discovery-agent"] = {
        "build": {
            "context": "../edge-gateway/discovery-agent",
            "dockerfile": "Dockerfile.test",
        },
        "environment": {
            "BALENA_DEVICE_UUID": "test-gateway-00000001",
            "EDGE_GATEWAY_API_TOKEN": "${TEST_EDGE_TOKEN:-}",
            "API_BASE_URL": "${API_BASE_URL:-http://api:3001}",
            "DISCOVERY_MODE": "docker-bridge",
            "SCAN_SUBNET": "172.30.0.0/24",
            "NETWORK_INTERFACE": "eth0",
            "DISCOVERY_INTERVAL": "10",
            "HEARTBEAT_INTERVAL": "30",
            "MQTT_BROKER": "mosquitto",
        },
        "cap_add": ["NET_RAW"],
        "depends_on": camera_deps + bulb_deps + ["mosquitto"],
        "networks": {
            "iot_lan": {"ipv4_address": "172.30.0.254"}
        },
    }

    compose = {
        "name": "nearhome-test-env",
        "services": services,
        "networks": {
            "iot_lan": {
                "driver": "bridge",
                "ipam": {
                    "config": [
                        {"subnet": "172.30.0.0/24", "gateway": "172.30.0.1"}
                    ]
                },
            }
        },
    }

    return compose


def main():
    parser = argparse.ArgumentParser(description="Generate test-env docker-compose")
    parser.add_argument("--cameras", type=int, default=3, help="Number of mock cameras")
    parser.add_argument("--bulbs", type=int, default=2, help="Number of mock bulbs")
    parser.add_argument("--output", type=str, default="docker-compose.generated.yml")
    args = parser.parse_args()

    compose = generate(args.cameras, args.bulbs)

    with open(args.output, "w") as f:
        yaml.dump(compose, f, default_flow_style=False, sort_keys=False)

    total = args.cameras + args.bulbs
    print(f"Generated {args.output} with {args.cameras} cameras + {args.bulbs} bulbs ({total} devices)")


if __name__ == "__main__":
    main()
