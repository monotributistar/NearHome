"""
Tests for mock IP camera containers.
Verifies RTSP streams and ONVIF SOAP responses.
"""

import subprocess

import pytest
import requests


ONVIF_SOAP_ENVELOPE = """<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <s:Body>
    <tds:GetDeviceInformation/>
  </s:Body>
</s:Envelope>"""


class TestMockCameraHealth:
    """Test mock camera health and basic connectivity."""

    def test_health_endpoint(self, camera_ips, wait_for_cameras):
        for ip in camera_ips:
            r = requests.get(f"http://{ip}:80/health", timeout=5)
            assert r.status_code == 200
            data = r.json()
            assert data["status"] == "ok"
            assert "camera_id" in data
            assert "manufacturer" in data

    def test_onvif_get_device_information(self, camera_ips, wait_for_cameras):
        for ip in camera_ips:
            r = requests.post(
                f"http://{ip}:80/onvif/device_service",
                data=ONVIF_SOAP_ENVELOPE,
                headers={"Content-Type": "application/soap+xml"},
                timeout=5,
            )
            assert r.status_code == 200
            assert "Manufacturer" in r.text
            assert "Model" in r.text
            assert "SerialNumber" in r.text

    def test_rtsp_port_open(self, camera_ips, wait_for_cameras):
        """Verify RTSP port 554 is open on each camera."""
        import socket

        for ip in camera_ips:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            result = sock.connect_ex((ip, 554))
            sock.close()
            assert result == 0, f"RTSP port 554 not open on {ip}"

    def test_rtsp_stream_with_ffprobe(self, camera_ips, wait_for_cameras):
        """Verify RTSP stream is accessible via ffprobe (if ffprobe available)."""
        for ip in camera_ips:
            try:
                result = subprocess.run(
                    [
                        "ffprobe",
                        "-v", "error",
                        "-rtsp_transport", "tcp",
                        "-show_entries", "stream=codec_type",
                        "-of", "csv=p=0",
                        f"rtsp://{ip}/stream",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                assert result.returncode == 0, f"ffprobe failed for {ip}: {result.stderr}"
                assert "video" in result.stdout
            except FileNotFoundError:
                pytest.skip("ffprobe not installed")


class TestMockCameraONVIF:
    """Test ONVIF SOAP responses in detail."""

    def test_get_profiles(self, camera_ips, wait_for_cameras):
        soap = """<?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
                    xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
          <s:Body><trt:GetProfiles/></s:Body>
        </s:Envelope>"""

        for ip in camera_ips:
            r = requests.post(
                f"http://{ip}:80",
                data=soap,
                headers={"Content-Type": "application/soap+xml"},
                timeout=5,
            )
            assert r.status_code == 200
            assert "MainStream" in r.text
            assert "H264" in r.text

    def test_unsupported_action_returns_fault(self, camera_ips, wait_for_cameras):
        soap = """<?xml version="1.0" encoding="UTF-8"?>
        <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
          <s:Body><SomeUnknownAction/></s:Body>
        </s:Envelope>"""

        for ip in camera_ips:
            r = requests.post(
                f"http://{ip}:80",
                data=soap,
                headers={"Content-Type": "application/soap+xml"},
                timeout=5,
            )
            assert r.status_code == 500
            assert "Fault" in r.text
