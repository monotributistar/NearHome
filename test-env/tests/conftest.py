"""
Pytest fixtures for test-env integration tests.
"""

import os
import time

import pytest
import requests

API_URL = os.environ.get("API_URL", "http://localhost:3001")
CAMERA_BASE_IP = os.environ.get("CAMERA_BASE_IP", "172.30.0.10")
BULB_BASE_IP = os.environ.get("BULB_BASE_IP", "172.30.0.20")
MOCK_CAMERA_COUNT = int(os.environ.get("MOCK_CAMERA_COUNT", "3"))
MOCK_BULB_COUNT = int(os.environ.get("MOCK_BULB_COUNT", "2"))


@pytest.fixture(scope="session")
def camera_ips():
    """List of mock camera IP addresses."""
    base = list(map(int, CAMERA_BASE_IP.split(".")))
    return [f"{base[0]}.{base[1]}.{base[2]}.{base[3] + i}" for i in range(MOCK_CAMERA_COUNT)]


@pytest.fixture(scope="session")
def bulb_ips():
    """List of mock bulb IP addresses."""
    base = list(map(int, BULB_BASE_IP.split(".")))
    return [f"{base[0]}.{base[1]}.{base[2]}.{base[3] + i}" for i in range(MOCK_BULB_COUNT)]


@pytest.fixture(scope="session")
def api_url():
    return API_URL


@pytest.fixture(scope="session")
def wait_for_cameras(camera_ips):
    """Wait for all mock cameras to be healthy."""
    for ip in camera_ips:
        url = f"http://{ip}:80/health"
        for attempt in range(15):
            try:
                r = requests.get(url, timeout=2)
                if r.status_code == 200:
                    break
            except requests.ConnectionError:
                pass
            time.sleep(2)
        else:
            pytest.skip(f"Camera at {ip} not reachable after 30s")


@pytest.fixture(scope="session")
def wait_for_bulbs(bulb_ips):
    """Wait for all mock bulbs to be healthy."""
    for ip in bulb_ips:
        url = f"http://{ip}:80/health"
        for attempt in range(15):
            try:
                r = requests.get(url, timeout=2)
                if r.status_code == 200:
                    break
            except requests.ConnectionError:
                pass
            time.sleep(2)
        else:
            pytest.skip(f"Bulb at {ip} not reachable after 30s")
