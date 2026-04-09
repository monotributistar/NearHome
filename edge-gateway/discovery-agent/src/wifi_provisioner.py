#!/usr/bin/env python3
"""
WiFi Provisioner for Edge Gateway
Configures WiFi on Raspberry Pi running balenaOS
"""

import logging
import os
import subprocess
from typing import Optional

logger = logging.getLogger("wifi-provisioner")


class WiFiProvisioner:
    """Manages WiFi configuration on Edge Gateway"""

    def __init__(self):
        self.current_network = None

    def get_current_network(self) -> Optional[dict]:
        """Get currently connected WiFi network"""
        try:
            result = subprocess.run(
                ["iw", "dev", "wlan0", "link"],
                capture_output=True,
                text=True,
                timeout=5
            )
            
            if result.returncode == 0:
                ssid = None
                for line in result.stdout.split("\n"):
                    if "SSID:" in line:
                        ssid = line.split("SSID:")[1].strip()
                
                if ssid:
                    self.current_network = {"ssid": ssid, "connected": True}
                    return self.current_network
                    
        except Exception as e:
            logger.debug(f"Failed to get current network: {e}")
        
        return None

    def scan_networks(self) -> list[dict]:
        """Scan for available WiFi networks"""
        networks = []
        
        try:
            # Put interface in monitor mode briefly to scan
            result = subprocess.run(
                ["iw", "dev", "wlan0", "scan"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                current_ssid = None
                for line in result.stdout.split("\n"):
                    if "SSID:" in line:
                        ssid = line.split("SSID:")[1].strip()
                        if ssid:
                            if current_ssid and current_ssid != ssid:
                                networks.append({"ssid": current_ssid})
                            current_ssid = ssid
                
                if current_ssid:
                    networks.append({"ssid": current_ssid})
                    
        except Exception as e:
            logger.error(f"WiFi scan failed: {e}")
        
        return networks

    def connect_wpa2(self, ssid: str, password: str) -> bool:
        """
        Connect to WPA2-Personal network
        
        Args:
            ssid: Network name
            password: Network password
        
        Returns:
            bool: True if connected successfully
        """
        logger.info(f"Connecting to WPA2 network: {ssid}")
        
        try:
            # Generate wpa_supplicant config
            config = f'''ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
country=US

network={{
    ssid="{ssid}"
    psk="{password}"
    key_mgmt=WPA-PSK
}}
'''
            # Write config
            with open("/tmp/wpa_supplicant.conf", "w") as f:
                f.write(config)
            
            # Apply using nmcli (NetworkManager) or wpa_cli
            result = subprocess.run(
                ["nmcli", "dev", "wifi", "connect", ssid, "password", password],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                logger.info(f"Successfully connected to {ssid}")
                self.current_network = {"ssid": ssid, "connected": True}
                return True
            else:
                logger.error(f"Failed to connect: {result.stderr}")
                return False
                
        except Exception as e:
            logger.error(f"WPA2 connection failed: {e}")
            return False

    def connect_wpa3(self, ssid: str, password: str) -> bool:
        """
        Connect to WPA3-Personal network
        
        Args:
            ssid: Network name
            password: Network password
        
        Returns:
            bool: True if connected successfully
        """
        logger.info(f"Connecting to WPA3 network: {ssid}")
        
        try:
            # WPA3 uses SAE instead of PSK
            config = f'''ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
country=US

network={{
    ssid="{ssid}"
    psk="{password}"
    key_mgmt=SAE
}}
'''
            with open("/tmp/wpa_supplicant.conf", "w") as f:
                f.write(config)
            
            result = subprocess.run(
                ["nmcli", "dev", "wifi", "connect", ssid, "password", password],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                logger.info(f"Successfully connected to WPA3 network {ssid}")
                self.current_network = {"ssid": ssid, "connected": True, "security": "wpa3"}
                return True
            else:
                logger.error(f"WPA3 connection failed: {result.stderr}")
                return False
                
        except Exception as e:
            logger.error(f"WPA3 connection failed: {e}")
            return False

    def connect_enterprise(self, ssid: str, username: str, password: str, 
                          cert_path: Optional[str] = None) -> bool:
        """
        Connect to WPA2/WPA3 Enterprise network
        
        Args:
            ssid: Network name
            username: EAP username
            password: EAP password
            cert_path: Optional path to CA certificate
        
        Returns:
            bool: True if connected successfully
        """
        logger.info(f"Connecting to Enterprise network: {ssid}")
        
        try:
            # Build wpa_supplicant config for enterprise
            config_lines = [
                "ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev",
                "update_config=1",
                "country=US",
                ""
            ]
            
            if cert_path:
                config_lines.append(f'ca_cert="{cert_path}"')
            
            config_lines.extend([
                'network={',
                f'    ssid="{ssid}"',
                '    key_mgmt=WPA-EAP',
                '    eap=TTLS',
                '    phase2="auth=MSCHAPV2"',
                f'    identity="{username}"',
                f'    password="{password}"',
                '}'
            ])
            
            config = "\n".join(config_lines)
            with open("/tmp/wpa_supplicant.conf", "w") as f:
                f.write(config)
            
            result = subprocess.run(
                ["nmcli", "dev", "wifi", "connect", ssid, 
                 "username", username, "password", password],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                logger.info(f"Connected to Enterprise network {ssid}")
                self.current_network = {"ssid": ssid, "connected": True, "security": "enterprise"}
                return True
            else:
                logger.error(f"Enterprise connection failed: {result.stderr}")
                return False
                
        except Exception as e:
            logger.error(f"Enterprise connection failed: {e}")
            return False

    def configure_from_env(self) -> bool:
        """
        Configure WiFi from environment variables
        
        Expected env vars:
        - WIFI_SSID: Network name
        - WIFI_PASSWORD: Network password
        - WIFI_SECURITY: wpa2, wpa3, or wpa2-enterprise
        - WIFI_USERNAME: For enterprise (optional)
        - WIFI_CERT_PATH: Path to CA certificate (optional)
        
        Returns:
            bool: True if configuration applied
        """
        ssid = os.environ.get("WIFI_SSID")
        password = os.environ.get("WIFI_PASSWORD")
        
        if not ssid or not password:
            logger.info("No WiFi configuration in environment")
            return False
        
        security = os.environ.get("WIFI_SECURITY", "wpa2").lower()
        username = os.environ.get("WIFI_USERNAME")
        cert_path = os.environ.get("WIFI_CERT_PATH")
        
        if security == "wpa3":
            return self.connect_wpa3(ssid, password)
        elif security == "wpa2-enterprise" and username:
            return self.connect_enterprise(ssid, username, password, cert_path)
        else:
            return self.connect_wpa2(ssid, password)


def main():
    """CLI for WiFi provisioning"""
    import sys
    import argparse
    
    parser = argparse.ArgumentParser(description="Edge Gateway WiFi Provisioner")
    parser.add_argument("action", choices=["scan", "connect", "status", "auto-config"],
                       help="Action to perform")
    parser.add_argument("--ssid", help="Network SSID")
    parser.add_argument("--password", help="Network password")
    parser.add_argument("--security", choices=["wpa2", "wpa3", "wpa2-enterprise"],
                       default="wpa2", help="Security type")
    parser.add_argument("--username", help="Username for enterprise")
    
    args = parser.parse_args()
    provisioner = WiFiProvisioner()
    
    if args.action == "scan":
        networks = provisioner.scan_networks()
        print(f"Found {len(networks)} networks:")
        for n in networks:
            print(f"  - {n.get('ssid')}")
    
    elif args.action == "connect":
        if not args.ssid or not args.password:
            print("Error: --ssid and --password required")
            sys.exit(1)
        
        if args.security == "wpa3":
            success = provisioner.connect_wpa3(args.ssid, args.password)
        elif args.security == "wpa2-enterprise" and args.username:
            success = provisioner.connect_enterprise(args.ssid, args.username, args.password)
        else:
            success = provisioner.connect_wpa2(args.ssid, args.password)
        
        print(f"Connection {'successful' if success else 'failed'}")
        sys.exit(0 if success else 1)
    
    elif args.action == "status":
        network = provisioner.get_current_network()
        if network:
            print(f"Connected to: {network.get('ssid')}")
        else:
            print("Not connected to WiFi")
    
    elif args.action == "auto-config":
        success = provisioner.configure_from_env()
        print(f"Auto-config {'applied' if success else 'not configured'}")


if __name__ == "__main__":
    main()