#!/usr/bin/env python3
"""
Minimal ONVIF SOAP responder for mock IP cameras.
Handles GetDeviceInformation, GetProfiles, and GetNetworkInterfaces.
"""

import os
import re
from http.server import HTTPServer, BaseHTTPRequestHandler

CAMERA_ID = os.environ.get("CAMERA_ID", "01")
MANUFACTURER = os.environ.get("CAMERA_MANUFACTURER", "GenericCam")
MODEL = os.environ.get("CAMERA_MODEL", "MockIPCam-1000")
SERIAL = os.environ.get("CAMERA_SERIAL", "MOCK-000001")
FIRMWARE = os.environ.get("CAMERA_FIRMWARE", "1.0.0")
ONVIF_PORT = int(os.environ.get("ONVIF_PORT", "80"))
RTSP_PORT = os.environ.get("RTSP_PORT", "554")
RESOLUTION = os.environ.get("STREAM_RESOLUTION", "640x480")

WIDTH, HEIGHT = RESOLUTION.split("x")

DEVICE_INFO_RESPONSE = f"""<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Body>
    <tds:GetDeviceInformationResponse>
      <tds:Manufacturer>{MANUFACTURER}</tds:Manufacturer>
      <tds:Model>{MODEL}</tds:Model>
      <tds:FirmwareVersion>{FIRMWARE}</tds:FirmwareVersion>
      <tds:SerialNumber>{SERIAL}</tds:SerialNumber>
      <tds:HardwareId>MOCK-HW-{CAMERA_ID}</tds:HardwareId>
    </tds:GetDeviceInformationResponse>
  </s:Body>
</s:Envelope>"""

PROFILES_RESPONSE = f"""<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Body>
    <trt:GetProfilesResponse>
      <trt:Profiles token="MainStream" fixed="true">
        <tt:Name>MainStream</tt:Name>
        <tt:VideoSourceConfiguration token="VSC_1">
          <tt:Name>VideoSource_1</tt:Name>
          <tt:UseCount>1</tt:UseCount>
          <tt:SourceToken>VS_1</tt:SourceToken>
          <tt:Bounds x="0" y="0" width="{WIDTH}" height="{HEIGHT}"/>
        </tt:VideoSourceConfiguration>
        <tt:VideoEncoderConfiguration token="VEC_1">
          <tt:Name>H264_MainStream</tt:Name>
          <tt:UseCount>1</tt:UseCount>
          <tt:Encoding>H264</tt:Encoding>
          <tt:Resolution>
            <tt:Width>{WIDTH}</tt:Width>
            <tt:Height>{HEIGHT}</tt:Height>
          </tt:Resolution>
          <tt:Quality>4.0</tt:Quality>
          <tt:RateControl>
            <tt:FrameRateLimit>25</tt:FrameRateLimit>
            <tt:EncodingInterval>1</tt:EncodingInterval>
            <tt:BitrateLimit>2048</tt:BitrateLimit>
          </tt:RateControl>
          <tt:H264>
            <tt:GovLength>30</tt:GovLength>
            <tt:H264Profile>Main</tt:H264Profile>
          </tt:H264>
        </tt:VideoEncoderConfiguration>
      </trt:Profiles>
    </trt:GetProfilesResponse>
  </s:Body>
</s:Envelope>"""

NETWORK_INTERFACES_RESPONSE = """<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Body>
    <tds:GetNetworkInterfacesResponse>
      <tds:NetworkInterfaces token="eth0">
        <tt:Enabled>true</tt:Enabled>
        <tt:Info>
          <tt:Name>eth0</tt:Name>
        </tt:Info>
      </tds:NetworkInterfaces>
    </tds:GetNetworkInterfacesResponse>
  </s:Body>
</s:Envelope>"""

GET_STREAM_URI_RESPONSE = f"""<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Body>
    <trt:GetStreamUriResponse>
      <trt:MediaUri>
        <tt:Uri>rtsp://localhost:{RTSP_PORT}/stream</tt:Uri>
        <tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>
        <tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>
        <tt:Timeout>PT60S</tt:Timeout>
      </trt:MediaUri>
    </trt:GetStreamUriResponse>
  </s:Body>
</s:Envelope>"""

SOAP_FAULT = """<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <s:Fault>
      <s:Code><s:Value>s:Sender</s:Value></s:Code>
      <s:Reason><s:Text xml:lang="en">Action not supported</s:Text></s:Reason>
    </s:Fault>
  </s:Body>
</s:Envelope>"""


def detect_action(body: str) -> str:
    """Detect the ONVIF action from SOAP body content."""
    actions = [
        "GetDeviceInformation",
        "GetProfiles",
        "GetNetworkInterfaces",
        "GetStreamUri",
        "GetCapabilities",
        "GetServices",
    ]
    for action in actions:
        if action in body:
            return action
    return "unknown"


class ONVIFHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[onvif-{CAMERA_ID}] {fmt % args}")

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                f'{{"status":"ok","camera_id":"{CAMERA_ID}","manufacturer":"{MANUFACTURER}","model":"{MODEL}"}}'.encode()
            )
            return

        # Return basic device info for GET requests (some ONVIF clients probe via GET)
        self.send_response(200)
        self.send_header("Content-Type", "text/xml; charset=utf-8")
        self.end_headers()
        self.wfile.write(DEVICE_INFO_RESPONSE.encode())

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8", errors="replace")

        action = detect_action(body)
        self.log_message("ONVIF action: %s", action)

        response_map = {
            "GetDeviceInformation": DEVICE_INFO_RESPONSE,
            "GetProfiles": PROFILES_RESPONSE,
            "GetNetworkInterfaces": NETWORK_INTERFACES_RESPONSE,
            "GetStreamUri": GET_STREAM_URI_RESPONSE,
            "GetCapabilities": DEVICE_INFO_RESPONSE,  # simplified
            "GetServices": DEVICE_INFO_RESPONSE,  # simplified
        }

        response = response_map.get(action, SOAP_FAULT)
        status = 200 if action in response_map else 500

        self.send_response(status)
        self.send_header("Content-Type", "application/soap+xml; charset=utf-8")
        self.end_headers()
        self.wfile.write(response.encode())


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", ONVIF_PORT), ONVIFHandler)
    print(f"[onvif-{CAMERA_ID}] ONVIF responder listening on :{ONVIF_PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"[onvif-{CAMERA_ID}] Shutting down ONVIF responder")
        server.shutdown()
