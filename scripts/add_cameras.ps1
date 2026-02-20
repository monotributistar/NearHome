# Agregar Camaras Imou a Shinobi Pro
# Ejecutar desde PowerShell

$SHINOBI_URL = "http://localhost:8080"
$EMAIL = "admin@shinobi.video"
$PASS = "admin"

# Camara 1
$CAMERA1_ID = "imou-entrada"
$CAMERA1_NAME = "Entrada Principal"
$CAMERA1_HOST = "192.168.0.161"
$CAMERA1_USER = "admin"
$CAMERA1_PASS = "L2EA8499"
$CAMERA1_PATH = "/cam/realmonitor?channel=1&subtype=1"

# Camara 2 (completar IP)
$CAMERA2_ID = "imou-otra"
$CAMERA2_NAME = "Otra Camara"
$CAMERA2_HOST = "192.168.0.XXX"  # <-- CAMBIAR IP
$CAMERA2_USER = "admin"
$CAMERA2_PASS = "L2EA8499"
$CAMERA2_PATH = "/cam/realmonitor?channel=1&subtype=1"

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "NearHome - Agregar Camaras a Shinobi" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan

# Paso 1: Login
Write-Host "`n[1/4] Autenticando..." -ForegroundColor Yellow

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = "mail=$EMAIL&pass=$PASS"

try {
    $loginResponse = Invoke-WebRequest -Uri "$SHINOBI_URL/" -Method POST -Body $loginBody -SessionVariable session -UseBasicParsing
    Write-Host "Login exitoso!" -ForegroundColor Green
} catch {
    Write-Host "Error en login: $_" -ForegroundColor Red
    Write-Host "Intenta agregar las camaras manualmente desde http://localhost:8080" -ForegroundColor Yellow
    exit 1
}

# Obtener auth_token de las cookies
$authToken = $session.Cookies.GetCookies($SHINOBI_URL) | Where-Object { $_.Name -eq "auth_token" } | Select-Object -ExpandProperty Value
$groupKey = $session.Cookies.GetCookies($SHINOBI_URL) | Where-Object { $_.Name -eq "group_key" } | Select-Object -ExpandProperty Value

if (-not $authToken) {
    Write-Host "No se obtuvo auth_token. Usando session..." -ForegroundColor Yellow
    # Intentar sin API key, usando session
}

Write-Host "Auth Token: $authToken" -ForegroundColor Gray
Write-Host "Group Key: $groupKey" -ForegroundColor Gray

# Paso 2: Agregar Camara 1
Write-Host "`n[2/4] Agregando Camara 1 - $CAMERA1_NAME..." -ForegroundColor Yellow

$camera1Body = @{
    mode = "start"
    mid = $CAMERA1_ID
    name = $CAMERA1_NAME
    type = "h264"
    protocol = "rtsp"
    host = $CAMERA1_HOST
    port = "554"
    path = $CAMERA1_PATH
    fps = "10"
    details = @{
        auto_host_enable = "1"
        auto_host = "rtsp://${CAMERA1_USER}:${CAMERA1_PASS}@${CAMERA1_HOST}:554${CAMERA1_PATH}"
        rtsp_transport = "tcp"
        muser = $CAMERA1_USER
        mpass = $CAMERA1_PASS
        stream_type = "mp4"
        stream_vcodec = "copy"
        stream_acodec = "no"
        detector = "1"
        detector_use_motion = "1"
    }
} | ConvertTo-Json -Depth 10

try {
    $url1 = "$SHINOBI_URL/$authToken/configureMonitor/$groupKey/$CAMERA1_ID"
    $result1 = Invoke-RestMethod -Uri $url1 -Method POST -Body $camera1Body -ContentType "application/json" -WebSession $session
    Write-Host "Camara 1 agregada!" -ForegroundColor Green
} catch {
    Write-Host "Error agregando camara 1: $_" -ForegroundColor Red
    Write-Host "Agrega manualmente desde http://localhost:8080" -ForegroundColor Yellow
}

# Paso 3: Agregar Camara 2
Write-Host "`n[3/4] Agregando Camara 2 - $CAMERA2_NAME..." -ForegroundColor Yellow

$camera2Body = @{
    mode = "start"
    mid = $CAMERA2_ID
    name = $CAMERA2_NAME
    type = "h264"
    protocol = "rtsp"
    host = $CAMERA2_HOST
    port = "554"
    path = $CAMERA2_PATH
    fps = "10"
    details = @{
        auto_host_enable = "1"
        auto_host = "rtsp://${CAMERA2_USER}:${CAMERA2_PASS}@${CAMERA2_HOST}:554${CAMERA2_PATH}"
        rtsp_transport = "tcp"
        muser = $CAMERA2_USER
        mpass = $CAMERA2_PASS
        stream_type = "mp4"
        stream_vcodec = "copy"
        stream_acodec = "no"
        detector = "1"
        detector_use_motion = "1"
    }
} | ConvertTo-Json -Depth 10

try {
    $url2 = "$SHINOBI_URL/$authToken/configureMonitor/$groupKey/$CAMERA2_ID"
    $result2 = Invoke-RestMethod -Uri $url2 -Method POST -Body $camera2Body -ContentType "application/json" -WebSession $session
    Write-Host "Camara 2 agregada!" -ForegroundColor Green
} catch {
    Write-Host "Error agregando camara 2: $_" -ForegroundColor Red
    Write-Host "Agrega manualmente desde http://localhost:8080" -ForegroundColor Yellow
}

# Paso 4: Verificar
Write-Host "`n[4/4] Verificando camaras..." -ForegroundColor Yellow

try {
    $monitorsUrl = "$SHINOBI_URL/$authToken/monitor/$groupKey"
    $monitors = Invoke-RestMethod -Uri $monitorsUrl -Method GET -WebSession $session
    Write-Host "Camaras configuradas:" -ForegroundColor Green
    $monitors | ForEach-Object { Write-Host "  - $($_.name) ($($_.mid))" }
} catch {
    Write-Host "No se pudieron listar camaras" -ForegroundColor Yellow
}

Write-Host "`n=====================================" -ForegroundColor Cyan
Write-Host "Listo! Accede a http://localhost:8080" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Cyan
