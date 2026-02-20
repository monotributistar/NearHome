$SHINOBI_URL = "http://localhost:8080"
$EMAIL = "admin@shinobi.video"
$PASS = "admin"

$CAMERA_ID = "imou-entrada"
$CAMERA_NAME = "Camara Entrada Imou"
$CAMERA_HOST = "192.168.0.161"
$CAMERA_USER = "admin"
$CAMERA_PASS = "L2EA8499"
$CAMERA_PATH = "/cam/realmonitor?channel=1&subtype=1"

Write-Host "=== Autenticando en Shinobi ===" -ForegroundColor Cyan

$authBody = @{
    mail = $EMAIL
    pass = $PASS
} | ConvertTo-Json

$authResponse = Invoke-RestMethod -Uri "$SHINOBI_URL`?json=true" -Method POST -Body $authBody -ContentType "application/json"

$API_KEY = $authResponse.auth_token
$GROUP_KEY = $authResponse.group_key

Write-Host "API Key: $API_KEY" -ForegroundColor Green
Write-Host "Group Key: $GROUP_KEY" -ForegroundColor Green

if (-not $API_KEY) {
    Write-Host "Error: No se pudo obtener API Key" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Agregando cámara ===" -ForegroundColor Cyan

$cameraData = @{
    mode = "start"
    mid = $CAMERA_ID
    name = $CAMERA_NAME
    type = "h264"
    protocol = "rtsp"
    host = $CAMERA_HOST
    port = "554"
    path = $CAMERA_PATH
    fps = "10"
    details = @{
        auto_host_enable = "1"
        auto_host = "rtsp://${CAMERA_USER}:${CAMERA_PASS}@${CAMERA_HOST}:554${CAMERA_PATH}"
        rtsp_transport = "tcp"
        muser = $CAMERA_USER
        mpass = $CAMERA_PASS
        stream_type = "mp4"
        stream_vcodec = "copy"
        stream_acodec = "no"
        detector = "1"
        detector_use_motion = "1"
    }
} | ConvertTo-Json -Depth 10

$addUrl = "$SHINOBI_URL/$API_KEY/configureMonitor/$GROUP_KEY/$CAMERA_ID"

try {
    $result = Invoke-RestMethod -Uri $addUrl -Method POST -Body $cameraData -ContentType "application/json"
    Write-Host "Cámara agregada exitosamente!" -ForegroundColor Green
    Write-Host ($result | ConvertTo-Json)
} catch {
    Write-Host "Error agregando cámara: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Verificando cámaras ===" -ForegroundColor Cyan

$monitors = Invoke-RestMethod -Uri "$SHINOBI_URL/$API_KEY/monitor/$GROUP_KEY" -Method GET
Write-Host ($monitors | ConvertTo-Json)

Write-Host ""
Write-Host "Listo! Accede a http://localhost:8080 para ver tu cámara" -ForegroundColor Green
