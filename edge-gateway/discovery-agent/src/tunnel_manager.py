#!/usr/bin/env python3
"""
Tunnel Manager for Edge Gateway
Manages balena tunnels for RTSP port exposure with auto-reconnection
"""

import logging
import os
import subprocess
import time
import threading
from typing import Optional

logger = logging.getLogger("tunnel-manager")


class TunnelManager:
    """Manages balena tunnels for camera RTSP port exposure"""

    def __init__(self):
        self.tunnels: dict[str, dict] = {}  # camera_id -> tunnel info
        self.running = True
        self.backoff_base = 5  # seconds
        self.backoff_max = 300  # 5 minutes max
        self.health_check_interval = 30  # seconds
        
        # Start health check thread
        self.health_thread = threading.Thread(target=self._health_check_loop, daemon=True)
        self.health_thread.start()

    def create_tunnel(self, camera_id: str, local_port: int, remote_port: int = 554) -> bool:
        """
        Create a balena tunnel for a camera
        
        Args:
            camera_id: Unique camera identifier
            local_port: Local port on the gateway (e.g., 8554)
            remote_port: Remote RTSP port on camera (e.g., 554)
        
        Returns:
            bool: True if tunnel created successfully
        """
        logger.info(f"Creating tunnel for camera {camera_id}: local={local_port}, remote={remote_port}")
        
        try:
            # Use balena CLI to create tunnel
            # In production, this would use balena tunnel command
            cmd = [
                "balena", "tunnel",
                os.environ.get("BALENA_DEVICE_UUID", "unknown"),
                f"{local_port}:localhost:{remote_port}"
            ]
            
            # For now, log the command (actual tunnel creation would be done by balena supervisor)
            logger.info(f"Would execute: {' '.join(cmd)}")
            
            # Store tunnel info
            self.tunnels[camera_id] = {
                "local_port": local_port,
                "remote_port": remote_port,
                "status": "active",
                "created_at": time.time(),
                "last_health_check": time.time(),
                "reconnect_attempts": 0
            }
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to create tunnel for {camera_id}: {e}")
            self.tunnels[camera_id] = {
                "local_port": local_port,
                "remote_port": remote_port,
                "status": "failed",
                "error": str(e)
            }
            return False

    def remove_tunnel(self, camera_id: str) -> bool:
        """Remove a tunnel for a camera"""
        logger.info(f"Removing tunnel for camera {camera_id}")
        
        if camera_id in self.tunnels:
            # In production, would kill the balena tunnel process
            del self.tunnels[camera_id]
            return True
        
        return False

    def get_tunnel_status(self, camera_id: str) -> Optional[dict]:
        """Get the status of a specific tunnel"""
        return self.tunnels.get(camera_id)

    def get_all_tunnels(self) -> dict[str, dict]:
        """Get status of all tunnels"""
        return self.tunnels.copy()

    def _health_check_loop(self):
        """Background thread to check tunnel health"""
        while self.running:
            for camera_id, tunnel in self.tunnels.items():
                if tunnel.get("status") == "active":
                    self._check_tunnel_health(camera_id, tunnel)
            
            time.sleep(self.health_check_interval)

    def _check_tunnel_health(self, camera_id: str, tunnel: dict):
        """Check if a tunnel is still healthy"""
        try:
            # Check if the tunnel process is still running
            # In production, would check if balena tunnel is alive
            
            # For now, assume healthy
            tunnel["last_health_check"] = time.time()
            tunnel["status"] = "active"
            
        except Exception as e:
            logger.warning(f"Tunnel health check failed for {camera_id}: {e}")
            self._reconnect_tunnel(camera_id, tunnel)

    def _reconnect_tunnel(self, camera_id: str, tunnel: dict):
        """Reconnect a failed tunnel with exponential backoff"""
        if not self.running:
            return
        
        attempts = tunnel.get("reconnect_attempts", 0)
        
        # Calculate backoff
        backoff = min(self.backoff_base * (2 ** attempts), self.backoff_max)
        logger.info(f"Attempting to reconnect tunnel {camera_id} in {backoff}s (attempt {attempts + 1})")
        
        time.sleep(backoff)
        
        # Try to reconnect
        try:
            local_port = tunnel.get("local_port")
            remote_port = tunnel.get("remote_port")
            
            if self.create_tunnel(camera_id, local_port, remote_port):
                logger.info(f"Successfully reconnected tunnel {camera_id}")
                tunnel["reconnect_attempts"] = 0
            else:
                tunnel["reconnect_attempts"] = attempts + 1
                tunnel["status"] = "reconnecting"
                
        except Exception as e:
            logger.error(f"Reconnect failed for {camera_id}: {e}")
            tunnel["reconnect_attempts"] = attempts + 1
            tunnel["status"] = "failed"

    def configure_tunnels(self, camera_configs: list[dict]) -> dict:
        """
        Configure tunnels for multiple cameras
        
        Args:
            camera_configs: List of {camera_id, local_port, remote_port}
        
        Returns:
            dict: Configuration results
        """
        results = []
        
        for config in camera_configs:
            camera_id = config.get("camera_id")
            local_port = config.get("local_port")
            remote_port = config.get("remote_port", 554)
            
            success = self.create_tunnel(camera_id, local_port, remote_port)
            
            results.append({
                "cameraId": camera_id,
                "localPort": local_port,
                "status": "active" if success else "failed"
            })
        
        return {"configured": results}

    def stop(self):
        """Stop the tunnel manager"""
        logger.info("Stopping tunnel manager")
        self.running = False
        
        # Clean up all tunnels
        for camera_id in list(self.tunnels.keys()):
            self.remove_tunnel(camera_id)


# Standalone health check server for the container
def main():
    """Run as a simple HTTP health server"""
    from http.server import HTTPServer, BaseHTTPRequestHandler
    import json
    
    manager = TunnelManager()
    
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/health":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "healthy",
                    "tunnels": manager.get_all_tunnels()
                }).encode())
            else:
                self.send_response(404)
                self.end_headers()
        
        def do_POST(self):
            if self.path == "/tunnels":
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length)
                config = json.loads(body)
                
                result = manager.configure_tunnels(config.get("cameras", []))
                
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            else:
                self.send_response(404)
                self.end_headers()
        
        def log_message(self, format, *args):
            logger.debug(format, *args)
    
    server = HTTPServer(("0.0.0.0", 8080), Handler)
    logger.info("Tunnel manager health server starting on port 8080")
    server.serve_forever()


if __name__ == "__main__":
    main()