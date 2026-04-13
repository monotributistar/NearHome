#!/usr/bin/env python3
"""
Edge Gateway Discovery Agent
Runs on balenaOS Raspberry Pi to discover and monitor IP cameras
"""

import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
import time
from datetime import datetime
from typing import Any, Optional
from urllib.parse import urlparse

import yaml

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("discovery-agent")


class DiscoveryAgent:
    """Main discovery agent for IP cameras"""

    def __init__(self, config_path: str = "config.yaml"):
        self.config = self._load_config(config_path)
        self.running = True
        self.discovery_interval = int(os.environ.get(
            "DISCOVERY_INTERVAL",
            self.config.get("discovery_interval", 60)
        ))
        self.heartbeat_interval = int(os.environ.get(
            "HEARTBEAT_INTERVAL",
            self.config.get("heartbeat_interval", 30)
        ))
        self.api_base_url = os.environ.get("API_BASE_URL", "http://api:3001")
        self.gateway_id = os.environ.get("BALENA_DEVICE_UUID", "unknown")
        self.api_token = os.environ.get("EDGE_GATEWAY_API_TOKEN", "")

        # Network scanning overrides (for Docker bridge / test environments)
        self.scan_subnet = os.environ.get("SCAN_SUBNET", "").strip()
        self.network_interface = os.environ.get(
            "NETWORK_INTERFACE",
            self.config.get("network_interface", "eth0")
        )
        self.discovery_mode = os.environ.get("DISCOVERY_MODE", "host")

        # MQTT broker for smart device discovery
        self.mqtt_broker = os.environ.get("MQTT_BROKER", "").strip()

        # Discovered devices cache
        self.discovered_cameras = []
        self.discovered_devices = []

        logger.info(f"Discovery Agent initialized for gateway: {self.gateway_id}")
        logger.info(f"  Mode: {self.discovery_mode}, Interface: {self.network_interface}")
        if self.scan_subnet:
            logger.info(f"  Scan subnet override: {self.scan_subnet}")

    def _load_config(self, config_path: str) -> dict:
        """Load configuration from YAML file"""
        try:
            with open(config_path, "r") as f:
                return yaml.safe_load(f)
        except FileNotFoundError:
            logger.warning(f"Config file {config_path} not found, using defaults")
            return {
                "discovery_interval": 60,
                "heartbeat_interval": 30,
                "network_interface": "eth0",
                "scan_subnet": "auto",
                "rtsp_ports": [554, 8554, 8080, 8000],
                "onvif_ports": [80, 8000, 8080]
            }

    def _get_local_ip(self) -> Optional[str]:
        """Get local IP address"""
        try:
            result = subprocess.run(
                ["ip", "addr", "show", self.network_interface],
                capture_output=True,
                text=True,
                timeout=5
            )
            for line in result.stdout.split("\n"):
                if "inet " in line:
                    return line.strip().split()[1].split("/")[0]
        except Exception as e:
            logger.warning(f"Failed to get local IP: {e}")
        return None

    def _arp_scan(self) -> list[dict[str, Any]]:
        """Perform ARP scan to discover devices on local network"""
        devices = []

        # Use explicit subnet if provided (Docker bridge / test mode)
        if self.scan_subnet:
            subnet = self.scan_subnet
        else:
            local_ip = self._get_local_ip()
            if not local_ip:
                logger.error("Cannot determine local IP, skipping ARP scan")
                return devices
            # Determine subnet from local IP (assuming /24)
            subnet = ".".join(local_ip.split(".")[:3]) + ".0/24"

        try:
            logger.info(f"Starting ARP scan on {subnet} (iface={self.network_interface})")
            arp_cmd = [
                "arp-scan",
                f"--interface={self.network_interface}",
                subnet,
            ]
            result = subprocess.run(
                arp_cmd,
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0 and result.stdout:
                try:
                    data = json.loads(result.stdout)
                    for iface in data.get("interface", []):
                        for host in iface.get("hosts", []):
                            devices.append({
                                "ip": host.get("ip", ""),
                                "mac": host.get("mac", ""),
                                "vendor": host.get("vendor", "")
                            })
                except json.JSONDecodeError:
                    # Fallback: parse text output
                    for line in result.stdout.split("\n"):
                        parts = line.split()
                        if len(parts) >= 2 and ":" in parts[0]:
                            devices.append({
                                "ip": parts[1] if len(parts) > 1 else "",
                                "mac": parts[0],
                                "vendor": ""
                            })
        except FileNotFoundError:
            logger.warning("arp-scan not installed, using alternative method")
            # Fallback to reading /proc/net/arp
            devices = self._arp_fallback()
        except subprocess.TimeoutExpired:
            logger.warning("ARP scan timed out")
        except Exception as e:
            logger.error(f"ARP scan failed: {e}")
        
        logger.info(f"ARP scan found {len(devices)} devices")
        return devices

    def _arp_fallback(self) -> list[dict[str, Any]]:
        """Fallback ARP scan using /proc/net/arp"""
        devices = []
        try:
            with open("/proc/net/arp", "r") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 4 and parts[0] != "IP":
                        mac = parts[3]
                        if mac != "00:00:00:00:00:00":
                            devices.append({
                                "ip": parts[0],
                                "mac": mac.upper(),
                                "vendor": ""
                            })
        except Exception as e:
            logger.error(f"ARP fallback failed: {e}")
        return devices

    def _check_port(self, ip: str, port: int, timeout: float = 2) -> bool:
        """Check if a port is open on an IP address"""
        try:
            result = subprocess.run(
                ["timeout", str(timeout), "bash", "-c", f"echo >/dev/tcp/{ip}/{port}"],
                capture_output=True,
                timeout=timeout + 1
            )
            return result.returncode == 0
        except Exception:
            return False

    def _onvif_probe(self, ip: str, port: int = 80) -> Optional[dict[str, Any]]:
        """Probe ONVIF endpoint for device information"""
        try:
            from onvif import ONVIFCamera
            
            # Create ONVIF camera connection
            cam = ONVIFCamera(ip, port, "admin", "admin", "/tmp/onvif")
            
            # Get device information
            dev_info = cam.devicemgmt.GetDeviceInformation()
            
            # Get network interfaces
            net_interfaces = cam.devicemgmt.GetNetworkInterfaces()
            
            # Get profiles
            profiles = cam.media.GetProfiles()
            
            return {
                "manufacturer": getattr(dev_info, "Manufacturer", ""),
                "model": getattr(dev_info, "Model", ""),
                "firmware": getattr(dev_info, "FirmwareVersion", ""),
                "serial": getattr(dev_info, "SerialNumber", ""),
                "uuid": str(getattr(dev_info, "HardwareId", "")),
                "profiles": [
                    {
                        "token": p.token,
                        "name": p.Name,
                        "video_encoding": getattr(p.VideoEncoderConfiguration, "Encoding", ""),
                        "resolution": {
                            "width": getattr(p.VideoEncoderConfiguration.Resolution, "Width", 0),
                            "height": getattr(p.VideoEncoderConfiguration.Resolution, "Height", 0)
                        }
                    }
                    for p in profiles if hasattr(p, "VideoEncoderConfiguration")
                ]
            }
        except ImportError:
            logger.debug("ONVIF library not available")
        except Exception as e:
            logger.debug(f"ONVIF probe failed for {ip}:{port}: {e}")
        
        return None

    def _discover_cameras(self) -> list[dict[str, Any]]:
        """Discover cameras on the local network"""
        cameras = []
        
        # Step 1: ARP scan to find devices
        devices = self._arp_scan()
        
        # Step 2: Check for RTSP/ONVIF ports
        rtsp_ports = self.config.get("rtsp_ports", [554, 8554, 8080, 8000])
        onvif_ports = self.config.get("onvif_ports", [80, 8000, 8080])
        
        for device in devices:
            ip = device.get("ip", "")
            if not ip or ip.startswith("127."):
                continue
            
            discovered_ports = []
            
            # Check RTSP ports
            for port in rtsp_ports:
                if self._check_port(ip, port):
                    discovered_ports.append(port)
                    logger.info(f"Found RTSP port {port} on {ip}")
            
            # Check ONVIF ports and probe
            onvif_info = None
            for port in onvif_ports:
                if self._check_port(ip, port):
                    onvif_info = self._onvif_probe(ip, port)
                    if onvif_info:
                        logger.info(f"Found ONVIF device at {ip}:{port} - {onvif_info.get('manufacturer')} {onvif_info.get('model')}")
                        break
            
            # If we found RTSP or ONVIF, add to cameras
            if discovered_ports or onvif_info:
                camera = {
                    "ipAddress": ip,
                    "macAddress": device.get("mac", "").replace("-", ":"),
                    "ports": discovered_ports,
                    "onvifInfo": onvif_info
                }
                
                # Generate RTSP URL if RTSP port found
                if 554 in discovered_ports:
                    camera["rtspUrl"] = f"rtsp://{ip}/stream"
                elif 8554 in discovered_ports:
                    camera["rtspUrl"] = f"rtsp://{ip}:8554/stream"
                
                cameras.append(camera)
        
        logger.info(f"Discovery found {len(cameras)} potential cameras")
        return cameras

    def _discover_smart_devices(self) -> list[dict[str, Any]]:
        """Discover smart IoT devices via mDNS and HTTP probing"""
        devices = []

        # Phase 1: mDNS service browsing
        try:
            from zeroconf import Zeroconf, ServiceBrowser

            found_services = []

            class Listener:
                def add_service(self, zc, type_, name):
                    info = zc.get_service_info(type_, name)
                    if info:
                        found_services.append(info)

                def remove_service(self, zc, type_, name):
                    pass

                def update_service(self, zc, type_, name):
                    pass

            zc = Zeroconf()
            browse_types = [
                "_nearhome-light._tcp.local.",
                "_hue._tcp.local.",
                "_http._tcp.local.",
            ]
            browsers = []
            for stype in browse_types:
                browsers.append(ServiceBrowser(zc, stype, Listener()))

            # Browse for 5 seconds
            time.sleep(5)

            for info in found_services:
                ip = None
                if info.addresses:
                    import socket
                    ip = socket.inet_ntoa(info.addresses[0])

                props = {}
                if info.properties:
                    props = {
                        k.decode() if isinstance(k, bytes) else k:
                        v.decode() if isinstance(v, bytes) else v
                        for k, v in info.properties.items()
                    }

                device_type = props.get("deviceType", "unknown")
                if device_type not in ("light", "switch", "sensor"):
                    continue

                device = {
                    "ipAddress": ip,
                    "macAddress": props.get("mac", ""),
                    "deviceType": device_type,
                    "manufacturer": props.get("manufacturer", ""),
                    "model": props.get("model", ""),
                    "protocol": "http+mqtt" if self.mqtt_broker else "http",
                    "httpPort": info.port or 80,
                    "capabilities": [],
                }

                # Phase 2: HTTP probe for full device info
                if ip:
                    try:
                        import requests as req
                        resp = req.get(f"http://{ip}:{device['httpPort']}/info", timeout=3)
                        if resp.status_code == 200:
                            info_data = resp.json()
                            device["manufacturer"] = info_data.get("manufacturer", device["manufacturer"])
                            device["model"] = info_data.get("model", device["model"])
                            device["macAddress"] = info_data.get("mac", device["macAddress"])
                            device["capabilities"] = info_data.get("capabilities", [])
                            device["firmwareVersion"] = info_data.get("firmware", "")
                    except Exception as e:
                        logger.debug(f"HTTP probe failed for {ip}: {e}")

                devices.append(device)

            zc.close()
            logger.info(f"mDNS discovery found {len(devices)} smart devices")

        except ImportError:
            logger.warning("zeroconf not installed, skipping mDNS discovery")
        except Exception as e:
            logger.error(f"Smart device discovery failed: {e}")

        return devices

    def _report_smart_devices(self):
        """Report discovered smart devices to Control Plane API"""
        if not self.api_token or not self.discovered_devices:
            return

        try:
            import requests

            url = f"{self.api_base_url}/api/v1/edge-gateways/{self.gateway_id}/devices/discover"
            payload = {
                "devices": self.discovered_devices,
                "discoveryTimestamp": datetime.utcnow().isoformat() + "Z"
            }

            response = requests.post(url, json=payload, headers={
                "Authorization": f"Bearer {self.api_token}"
            }, timeout=30)

            logger.info(f"Smart device report sent: {response.status_code}")

            if response.status_code == 200:
                result = response.json()
                logger.info(
                    f"Devices discovered: {len(result.get('discovered', []))}, "
                    f"already registered: {len(result.get('alreadyRegistered', []))}"
                )

        except Exception as e:
            logger.error(f"Failed to report smart devices: {e}")

    def _send_heartbeat(self):
        """Send heartbeat to Control Plane API"""
        try:
            # Collect system metrics
            import psutil
            
            metrics = {
                "cpuUsagePercent": psutil.cpu_percent(interval=1),
                "cpuTemperatureCelsius": self._get_cpu_temp(),
                "memoryUsedBytes": psutil.virtual_memory().used,
                "memoryTotalBytes": psutil.virtual_memory().total,
                "discoveredCamerasCount": len(self.discovered_cameras),
                "registeredCamerasCount": 0  # Would come from API
            }
            
            # Try to get VPN latency
            try:
                result = subprocess.run(
                    ["ping", "-c", "1", "-W", "2", "8.8.8.8"],
                    capture_output=True,
                    timeout=3
                )
                if result.returncode == 0:
                    # Parse latency from output
                    output = result.stdout.decode()
                    import re
                    match = re.search(r"time=(\d+\.?\d*)", output)
                    if match:
                        metrics["vpnLatencyMs"] = float(match.group(1))
            except Exception:
                pass
            
            heartbeat_data = {
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "supervisorStatus": {
                    "deviceStatus": "running",
                    "isOnline": True,
                    "updateStatus": "up-to-date"
                },
                "customMetrics": metrics,
                "version": "1.0.0"
            }
            
            # Send heartbeat
            if self.api_token:
                url = f"{self.api_base_url}/api/v1/edge-gateways/{self.gateway_id}/heartbeat"
                import requests
                response = requests.post(url, json=heartbeat_data, headers={
                    "Authorization": f"Bearer {self.api_token}"
                }, timeout=10)
                logger.info(f"Heartbeat sent: {response.status_code}")
            else:
                logger.warning("No API token, skipping heartbeat")
                
        except Exception as e:
            logger.error(f"Failed to send heartbeat: {e}")

    def _get_cpu_temp(self) -> float:
        """Get CPU temperature on Raspberry Pi"""
        try:
            # Try thermal zone
            with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
                return float(f.read().strip()) / 1000
        except Exception:
            pass
        
        # Try vcgencmd (Raspberry Pi)
        try:
            result = subprocess.run(
                ["vcgencmd", "measure_temp"],
                capture_output=True,
                text=True,
                timeout=2
            )
            if result.returncode == 0:
                temp_str = result.stdout.split("=")[1].split("'")[0]
                return float(temp_str)
        except Exception:
            pass
        
        return 0.0

    def _report_cameras(self):
        """Report discovered cameras to Control Plane API"""
        if not self.api_token or not self.discovered_cameras:
            return
        
        try:
            import requests
            
            url = f"{self.api_base_url}/api/v1/edge-gateways/{self.gateway_id}/cameras/discover"
            payload = {
                "cameras": self.discovered_cameras,
                "discoveryTimestamp": datetime.utcnow().isoformat() + "Z"
            }
            
            response = requests.post(url, json=payload, headers={
                "Authorization": f"Bearer {self.api_token}"
            }, timeout=30)
            
            logger.info(f"Camera report sent: {response.status_code}")
            
            if response.status_code == 200:
                result = response.json()
                logger.info(f"Discovered: {len(result.get('discovered', []))}, Already registered: {len(result.get('alreadyRegistered', []))}")
                
        except Exception as e:
            logger.error(f"Failed to report cameras: {e}")

    async def discovery_loop(self):
        """Main discovery loop"""
        logger.info("Starting discovery loop")

        while self.running:
            try:
                # Discover cameras
                self.discovered_cameras = self._discover_cameras()
                self._report_cameras()

                # Discover smart devices (lights, switches, sensors)
                self.discovered_devices = self._discover_smart_devices()
                self._report_smart_devices()

            except Exception as e:
                logger.error(f"Discovery loop error: {e}")
            
            # Wait for next interval
            for _ in range(self.discovery_interval):
                if not self.running:
                    break
                await asyncio.sleep(1)

    async def heartbeat_loop(self):
        """Heartbeat loop - runs every 30 seconds"""
        logger.info("Starting heartbeat loop")
        
        while self.running:
            try:
                self._send_heartbeat()
            except Exception as e:
                logger.error(f"Heartbeat error: {e}")
            
            # Wait for next interval
            for _ in range(self.heartbeat_interval):
                if not self.running:
                    break
                await asyncio.sleep(1)

    def run(self):
        """Run the discovery agent"""
        logger.info("Starting Discovery Agent")
        
        # Setup signal handlers for graceful shutdown
        def signal_handler(signum, frame):
            logger.info("Received shutdown signal")
            self.running = False
        
        signal.signal(signal.SIGTERM, signal_handler)
        signal.signal(signal.SIGINT, signal_handler)
        
        # Run both loops
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            loop.run_until_complete(asyncio.gather(
                self.discovery_loop(),
                self.heartbeat_loop()
            ))
        except KeyboardInterrupt:
            logger.info("Interrupted by user")
        finally:
            loop.close()
            logger.info("Discovery Agent stopped")


if __name__ == "__main__":
    config_path = sys.argv[1] if len(sys.argv) > 1 else "config.yaml"
    agent = DiscoveryAgent(config_path)
    agent.run()