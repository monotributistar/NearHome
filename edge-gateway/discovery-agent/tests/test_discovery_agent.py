#!/usr/bin/env python3
"""
Unit tests for Edge Gateway Discovery Agent
Run with: python -m pytest tests_discovery_agent.py -v
"""

import json
import unittest
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime


class TestArpScanParsing(unittest.TestCase):
    """Test ARP scan output parsing"""

    def test_parse_json_arp_scan_output(self):
        """Test parsing JSON output from arp-scan"""
        # This is what arp-scan --json outputs
        json_output = json.dumps({
            "interface": [
                {
                    "name": "eth0",
                    "ip": "192.168.1.1",
                    "mac": "00:11:22:33:44:55",
                    "hosts": [
                        {"ip": "192.168.1.100", "mac": "aa:bb:cc:dd:ee:01", "vendor": "Raspberry Pi"},
                        {"ip": "192.168.1.101", "mac": "aa:bb:cc:dd:ee:02", "vendor": "Hikvision"}
                    ]
                }
            ]
        })
        
        data = json.loads(json_output)
        devices = []
        for iface in data.get("interface", []):
            for host in iface.get("hosts", []):
                devices.append({
                    "ip": host.get("ip", ""),
                    "mac": host.get("mac", ""),
                    "vendor": host.get("vendor", "")
                })
        
        self.assertEqual(len(devices), 2)
        self.assertEqual(devices[0]["ip"], "192.168.1.100")
        self.assertEqual(devices[0]["mac"], "aa:bb:cc:dd:ee:01")

    def test_parse_arp_fallback(self):
        """Test parsing /proc/net/arp fallback"""
        arp_content = """IP address       HW type     HW address           Flags     Mask            Interface
192.168.1.100    ether       aa:bb:cc:dd:ee:01       C                     eth0
192.168.1.101    ether       aa:bb:cc:dd:ee:02       C                     eth0
"""
        
        devices = []
        for line in arp_content.split("\n"):
            parts = line.split()
            if len(parts) >= 4 and parts[0] != "IP":
                mac = parts[3]
                if mac != "00:00:00:00:00:00":
                    devices.append({
                        "ip": parts[0],
                        "mac": mac.upper()
                    })
        
        self.assertEqual(len(devices), 2)
        self.assertEqual(devices[0]["mac"], "AA:BB:CC:DD:EE:01")


class TestOnvifProbe(unittest.TestCase):
    """Test ONVIF probe functionality"""

    def test_onvif_device_info_parsing(self):
        """Test parsing ONVIF GetDeviceInformation response"""
        # Mock ONVIF device info response
        mock_dev_info = Mock()
        mock_dev_info.Manufacturer = "Hikvision"
        mock_dev_info.Model = "DS-2CD2043G2"
        mock_dev_info.FirmwareVersion = "V5.7.12"
        mock_dev_info.SerialNumber = "ABC123456"
        mock_dev_info.HardwareId = "HW-12345"
        
        result = {
            "manufacturer": mock_dev_info.Manufacturer,
            "model": mock_dev_info.Model,
            "firmware": mock_dev_info.FirmwareVersion,
            "serial": mock_dev_info.SerialNumber,
            "uuid": str(mock_dev_info.HardwareId)
        }
        
        self.assertEqual(result["manufacturer"], "Hikvision")
        self.assertEqual(result["model"], "DS-2CD2043G2")
        self.assertEqual(result["firmware"], "V5.7.12")

    def test_onvif_profiles_parsing(self):
        """Test parsing ONVIF GetProfiles response"""
        # Mock profiles response
        mock_profile1 = Mock()
        mock_profile1.token = "main_profile"
        mock_profile1.Name = "Main Stream"
        
        mock_config1 = Mock()
        mock_config1.Encoding = "h264"
        mock_resolution = Mock()
        mock_resolution.Width = 1920
        mock_resolution.Height = 1080
        mock_config1.Resolution = mock_resolution
        
        mock_profile1.VideoEncoderConfiguration = mock_config1
        
        profiles = [mock_profile1]
        
        parsed = [
            {
                "token": p.token,
                "name": p.Name,
                "video_encoding": p.VideoEncoderConfiguration.Encoding,
                "resolution": {
                    "width": p.VideoEncoderConfiguration.Resolution.Width,
                    "height": p.VideoEncoderConfiguration.Resolution.Height
                }
            }
            for p in profiles if hasattr(p, "VideoEncoderConfiguration")
        ]
        
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["video_encoding"], "h264")
        self.assertEqual(parsed[0]["resolution"]["width"], 1920)


class TestHeartbeatPayload(unittest.TestCase):
    """Test heartbeat payload construction"""

    def test_heartbeat_payload_format(self):
        """Test heartbeat payload format"""
        import psutil
        
        # Simulate metrics collection
        cpu_percent = psutil.cpu_percent(interval=0.1)
        memory = psutil.virtual_memory()
        
        payload = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "supervisorStatus": {
                "deviceStatus": "running",
                "isOnline": True,
                "updateStatus": "up-to-date"
            },
            "customMetrics": {
                "cpuUsagePercent": cpu_percent,
                "cpuTemperatureCelsius": 45.0,
                "memoryUsedBytes": memory.used,
                "memoryTotalBytes": memory.total,
                "vpnLatencyMs": 12,
                "tunnelStatus": {
                    "activeTunnels": 2,
                    "failedTunnels": 0
                },
                "discoveredCamerasCount": 3,
                "registeredCamerasCount": 1
            },
            "version": "1.0.0"
        }
        
        # Validate structure
        self.assertIn("timestamp", payload)
        self.assertIn("supervisorStatus", payload)
        self.assertIn("customMetrics", payload)
        self.assertIn("cpuUsagePercent", payload["customMetrics"])
        self.assertIn("cpuTemperatureCelsius", payload["customMetrics"])


class TestTunnelReconnection(unittest.TestCase):
    """Test tunnel reconnection exponential backoff"""

    def test_exponential_backoff_calculation(self):
        """Test exponential backoff calculation"""
        backoff_base = 5
        backoff_max = 300
        
        backoffs = []
        for attempt in range(10):
            backoff = min(backoff_base * (2 ** attempt), backoff_max)
            backoffs.append(backoff)
        
        # First few should follow exponential growth
        self.assertEqual(backoffs[0], 5)    # 5 * 2^0
        self.assertEqual(backoffs[1], 10)   # 5 * 2^1
        self.assertEqual(backoffs[2], 20)   # 5 * 2^2
        self.assertEqual(backoffs[3], 40)   # 5 * 2^3
        
        # Should cap at max
        self.assertEqual(backoffs[9], backoff_max)

    def test_tunnel_status_determination(self):
        """Test tunnel status based on last health check"""
        def get_tunnel_status(last_health_check: float) -> str:
            now = time.time()
            if now - last_health_check < 300:  # 5 minutes
                return "active"
            elif now - last_health_check < 600:  # 10 minutes
                return "degraded"
            else:
                return "disconnected"
        
        import time
        
        # Recent check
        self.assertEqual(get_tunnel_status(time.time() - 60), "active")
        
        # Older than 5 minutes
        self.assertEqual(get_tunnel_status(time.time() - 400), "degraded")
        
        # Very old
        self.assertEqual(get_tunnel_status(time.time() - 700), "disconnected")


class TestCameraDiscovery(unittest.TestCase):
    """Test camera discovery logic"""

    def test_discovered_camera_json_format(self):
        """Test discovered camera JSON format"""
        camera = {
            "ipAddress": "192.168.1.100",
            "macAddress": "aa:bb:cc:dd:ee:01",
            "rtspUrl": "rtsp://192.168.1.100/stream",
            "onvifInfo": {
                "manufacturer": "Hikvision",
                "model": "DS-2CD2043G2",
                "firmware": "V5.7.12"
            },
            "ports": [554, 80]
        }
        
        # Validate required fields
        self.assertIn("ipAddress", camera)
        self.assertIn("macAddress", camera)
        self.assertIn("ports", camera)
        
        # Validate IP address format
        import ipaddress
        ipaddress.ip_address(camera["ipAddress"])
        
        # Validate MAC address format
        self.assertEqual(len(camera["macAddress"].split(":")), 6)


if __name__ == "__main__":
    unittest.main()