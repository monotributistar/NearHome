# Edge Gateway API Documentation

This document describes the API endpoints for managing Edge Gateway devices.

## Base URL

```
Production: https://api.nearhome.dev/api/v1
Development: http://localhost:3001/api/v1
```

## Authentication

Edge Gateway devices authenticate using an API token returned during registration:

```
Authorization: Bearer <api_token>
```

---

## Endpoints

### 1. Register Edge Gateway

Register a new edge gateway device with the control plane.

**Endpoint:** `POST /edge-gateways/register`

**Request Body:**

```json
{
  "balenaDeviceUUID": "uuid-string",
  "balenaAppId": "app-uuid",
  "balenaFleetId": "fleet-uuid",
  "deviceName": "gateway-01",
  "osVersion": "2.114.0",
  "supervisorVersion": "14.0.0",
  "tenantId": "tenant-uuid",  // Optional - can be assigned later
  "networkConfig": {
    "type": "ethernet" | "wifi",
    "ssid": "NetworkName",        // If wifi
    "password": "password",       // If wifi
    "security": "wpa2" | "wpa3" | "wpa2-enterprise"
  }
}
```

**Response (201):**

```json
{
  "id": "edge-gateway-id",
  "apiToken": "generated-token",
  "tenantId": "tenant-id",
  "status": "pending"
}
```

**Errors:**

- `409`: Device already registered
- `400`: Invalid request body

---

### 2. Get Edge Gateway

Retrieve details of an edge gateway.

**Endpoint:** `GET /edge-gateways/:id`

**Response (200):**

```json
{
  "data": {
    "id": "edge-gateway-id",
    "tenantId": "tenant-id",
    "balenaDeviceUUID": "uuid",
    "deviceName": "gateway-01",
    "status": "active",
    "registeredAt": "2026-04-07T10:00:00Z",
    "lastHeartbeatAt": "2026-04-07T12:00:00Z",
    "discoveredCameras": [...]
  }
}
```

---

### 3. Device Heartbeat

Send heartbeat with system metrics.

**Endpoint:** `POST /edge-gateways/:id/heartbeat`

**Request Body:**

```json
{
  "timestamp": "2026-04-07T12:00:00Z",
  "supervisorStatus": {
    "deviceStatus": "running",
    "isOnline": true,
    "updateStatus": "up-to-date",
    "supervisorVersion": "14.0.0",
    "osVersion": "2.114.0"
  },
  "customMetrics": {
    "cpuUsagePercent": 23.5,
    "cpuTemperatureCelsius": 45.2,
    "memoryUsedBytes": 1024000000,
    "memoryTotalBytes": 2048000000,
    "vpnLatencyMs": 12,
    "tunnelStatus": {
      "activeTunnels": 2,
      "failedTunnels": 0
    },
    "discoveredCamerasCount": 4,
    "registeredCamerasCount": 2
  },
  "version": "1.0.0"
}
```

**Response (200):**

```json
{
  "accepted": true,
  "nextHeartbeatIntervalSeconds": 30,
  "status": "active"
}
```

---

### 4. Report Discovered Cameras

Report cameras found on the local network.

**Endpoint:** `POST /edge-gateways/:id/cameras/discover`

**Request Body:**

```json
{
  "cameras": [
    {
      "ipAddress": "192.168.1.100",
      "macAddress": "b8:27:eb:12:34:56",
      "rtspUrl": "rtsp://192.168.1.100/stream",
      "onvifInfo": {
        "manufacturer": "Hikvision",
        "model": "DS-2CD2043G2",
        "firmware": "V5.7.12"
      },
      "ports": [554, 80]
    }
  ],
  "discoveryTimestamp": "2026-04-07T12:00:00Z"
}
```

**Response (200):**

```json
{
  "discovered": [
    {
      "ipAddress": "192.168.1.100",
      "macAddress": "b8:27:eb:12:34:56",
      "manufacturer": "Hikvision",
      "model": "DS-2CD2043G2"
    }
  ],
  "alreadyRegistered": []
}
```

---

### 5. Confirm Camera

Confirm and register a discovered camera with credentials.

**Endpoint:** `POST /edge-gateways/:id/cameras/confirm`

**Request Body:**

```json
{
  "macAddress": "b8:27:eb:12:34:56",
  "rtspUrl": "rtsp://192.168.1.100:554/stream",
  "username": "admin",
  "password": "camera-password"
}
```

**Response (201):**

```json
{
  "cameraId": "camera-uuid",
  "discoveredCameraId": "discovered-camera-uuid",
  "status": "registered",
  "tunnelPort": 8554
}
```

---

### 6. List Discovered Cameras

List all cameras for an edge gateway.

**Endpoint:** `GET /edge-gateways/:id/cameras`

**Query Parameters:**

- `status`: Filter by status (`discovered`, `pending`, `registered`)

**Response (200):**

```json
{
  "data": [
    {
      "id": "discovered-camera-id",
      "macAddress": "b8:27:eb:12:34:56",
      "ipAddress": "192.168.1.100",
      "manufacturer": "Hikvision",
      "model": "DS-2CD2043G2",
      "status": "registered",
      "lastSeenAt": "2026-04-07T12:00:00Z"
    }
  ]
}
```

---

### 7. Configure Tunnels

Configure balena tunnels for RTSP access.

**Endpoint:** `POST /edge-gateways/:id/tunnels`

**Request Body:**

```json
{
  "cameras": [
    {
      "cameraId": "discovered-camera-id",
      "rtspPort": 554,
      "localPort": 8554
    }
  ]
}
```

**Response (200):**

```json
{
  "configured": [
    {
      "cameraId": "discovered-camera-id",
      "localPort": 8554,
      "status": "active"
    }
  ]
}
```

---

### 8. Get Tunnel Status

Get status of all configured tunnels.

**Endpoint:** `GET /edge-gateways/:id/tunnels/status`

**Response (200):**

```json
{
  "tunnels": [
    {
      "cameraId": "discovered-camera-id",
      "localPort": 8554,
      "status": "active",
      "lastHealthCheck": "2026-04-07T12:00:00Z"
    }
  ]
}
```

---

### 9. Decommission Edge Gateway

Mark an edge gateway as decommissioned.

**Endpoint:** `DELETE /edge-gateways/:id`

**Response (204):** No content

---

## Event Gateway Integration

The event gateway processes edge gateway health events:

**Endpoint:** `POST /health/edge-gateway`

This endpoint receives heartbeat events and publishes them to subscribers via WebSocket/SSE.

---

## WebSocket Events

Edge gateway health events are published to subscribers:

```json
{
  "eventId": "evt_123456_abc",
  "eventVersion": "1.0",
  "eventType": "edge_gateway.health",
  "tenantId": "tenant-uuid",
  "occurredAt": "2026-04-07T12:00:00Z",
  "payload": {
    "gatewayId": "edge-gateway-id",
    "timestamp": "2026-04-07T12:00:00Z",
    "status": "healthy",
    "metrics": {...}
  }
}
```
