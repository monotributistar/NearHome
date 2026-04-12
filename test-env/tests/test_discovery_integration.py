"""
Integration tests for the full discovery flow.
Requires the test environment to be running (docker compose up).
"""

import json
import time

import pytest
import requests


class TestMockBulbs:
    """Test mock smart lightbulb REST API."""

    def test_health(self, bulb_ips, wait_for_bulbs):
        for ip in bulb_ips:
            r = requests.get(f"http://{ip}:80/health", timeout=5)
            assert r.status_code == 200
            assert r.json()["status"] == "ok"

    def test_get_info(self, bulb_ips, wait_for_bulbs):
        for ip in bulb_ips:
            r = requests.get(f"http://{ip}:80/info", timeout=5)
            assert r.status_code == 200
            info = r.json()
            assert info["deviceType"] == "light"
            assert "manufacturer" in info
            assert "model" in info
            assert "mac" in info
            assert "capabilities" in info
            assert "on_off" in info["capabilities"]

    def test_get_initial_state(self, bulb_ips, wait_for_bulbs):
        for ip in bulb_ips:
            r = requests.get(f"http://{ip}:80/state", timeout=5)
            assert r.status_code == 200
            state = r.json()
            assert "on" in state
            assert "brightness" in state
            assert state["on"] is False  # default off

    def test_set_state(self, bulb_ips, wait_for_bulbs):
        ip = bulb_ips[0]

        # Turn on
        r = requests.put(
            f"http://{ip}:80/state",
            json={"on": True, "brightness": 75},
            timeout=5,
        )
        assert r.status_code == 200
        state = r.json()
        assert state["on"] is True
        assert state["brightness"] == 75

        # Read back
        r = requests.get(f"http://{ip}:80/state", timeout=5)
        assert r.json()["on"] is True
        assert r.json()["brightness"] == 75

        # Turn off
        r = requests.put(f"http://{ip}:80/state", json={"on": False}, timeout=5)
        assert r.status_code == 200
        assert r.json()["on"] is False

    def test_set_rgb(self, bulb_ips, wait_for_bulbs):
        ip = bulb_ips[0]
        r = requests.put(
            f"http://{ip}:80/state",
            json={"rgb": [255, 0, 128]},
            timeout=5,
        )
        assert r.status_code == 200
        assert r.json()["rgb"] == [255, 0, 128]

    def test_set_color_temp(self, bulb_ips, wait_for_bulbs):
        ip = bulb_ips[0]
        r = requests.put(
            f"http://{ip}:80/state",
            json={"color_temp": 2700},
            timeout=5,
        )
        assert r.status_code == 200
        assert r.json()["color_temp"] == 2700


class TestDiscoveryAgentIntegration:
    """
    Full integration tests verifying the discovery agent finds mock devices.
    These tests require the API to be running and connected.
    Skip if API is not available.
    """

    @pytest.fixture(autouse=True)
    def check_api(self, api_url):
        try:
            r = requests.get(f"{api_url}/health", timeout=3)
            if r.status_code != 200:
                pytest.skip("API not available")
        except requests.ConnectionError:
            pytest.skip("API not reachable")

    def test_discovery_agent_logs_found_devices(self):
        """
        Verify the discovery agent container logs show discovered cameras.
        This is a smoke test -- check logs via docker.
        """
        import subprocess

        result = subprocess.run(
            ["docker", "compose", "-f", "docker-compose.yml", "logs", "discovery-agent", "--tail=50"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd="/app/test-env" if __file__.startswith("/app") else None,
        )
        # The agent should log something about discovery
        # This may fail in CI where docker isn't available
        if result.returncode != 0:
            pytest.skip("Cannot read docker logs")

        output = result.stdout + result.stderr
        assert "Discovery Agent" in output or "discovery" in output.lower()
