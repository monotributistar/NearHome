import requests
import json

SHINOBI_URL = "http://localhost:8080"
EMAIL = "admin@shinobi.video"
PASS = "admin"

CAMERAS = [
    {
        "mid": "imou-entrada",
        "name": "Entrada Principal",
        "host": "192.168.0.161",
        "user": "admin",
        "password": "L2EA8499"
    },
    {
        "mid": "imou-otra",
        "name": "Otra Camara",
        "host": "192.168.0.177",
        "user": "admin",
        "password": "L276228D"
    }
]

def main():
    session = requests.Session()
    
    print("=" * 50)
    print("NearHome - Agregar Camaras a Shinobi Pro")
    print("=" * 50)
    
    # Paso 1: Login
    print("\n[1/3] Autenticando...")
    
    login_data = {
        "mail": EMAIL,
        "pass": PASS
    }
    
    response = session.post(f"{SHINOBI_URL}/", data=login_data, allow_redirects=True)
    
    if response.status_code != 200:
        print(f"Error en login: {response.status_code}")
        return
    
    # Obtener cookies
    cookies = session.cookies.get_dict()
    print(f"Cookies: {cookies}")
    
    # Intentar obtener auth_token de las cookies
    auth_token = cookies.get("auth_token") or cookies.get("api") or cookies.get("shinobi_session")
    
    if not auth_token:
        print("No se encontro auth_token en cookies")
        print("Intentando obtener desde la pagina...")
        
        # Buscar en el HTML
        if "auth_token" in response.text:
            import re
            match = re.search(r'auth_token["\']?\s*[:=]\s*["\']([^"\']+)["\']', response.text)
            if match:
                auth_token = match.group(1)
                print(f"auth_token encontrado: {auth_token}")
    
    # Paso 2: Agregar camaras
    print("\n[2/3] Agregando camaras...")
    
    for camera in CAMERAS:
        print(f"\n  Agregando: {camera['name']} ({camera['host']})")
        
        rtsp_url = f"rtsp://{camera['user']}:{camera['password']}@{camera['host']}:554/cam/realmonitor?channel=1&subtype=1"
        
        monitor_data = {
            "mode": "start",
            "mid": camera["mid"],
            "name": camera["name"],
            "type": "h264",
            "protocol": "rtsp",
            "host": camera["host"],
            "port": "554",
            "path": "/cam/realmonitor?channel=1&subtype=1",
            "fps": "10",
            "details": json.dumps({
                "auto_host_enable": "1",
                "auto_host": rtsp_url,
                "rtsp_transport": "tcp",
                "muser": camera["user"],
                "mpass": camera["password"],
                "stream_type": "mp4",
                "stream_vcodec": "copy",
                "stream_acodec": "no",
                "detector": "1",
                "detector_use_motion": "1"
            })
        }
        
        # Intentar con API key si tenemos
        if auth_token:
            url = f"{SHINOBI_URL}/{auth_token}/configureMonitor/{auth_token}/{camera['mid']}"
            resp = session.post(url, json=monitor_data)
            print(f"    Respuesta API: {resp.status_code} - {resp.text[:100]}")
        
        # Intentar con session directamente
        url = f"{SHINOBI_URL}/configureMonitor/{camera['mid']}"
        resp = session.post(url, data=monitor_data, allow_redirects=True)
        print(f"    Respuesta Session: {resp.status_code}")
    
    # Paso 3: Verificar
    print("\n[3/3] Verificando camaras...")
    
    if auth_token:
        resp = session.get(f"{SHINOBI_URL}/{auth_token}/monitor/{auth_token}")
        print(f"Monitores: {resp.text[:200]}")
    
    print("\n" + "=" * 50)
    print("Listo! Accede a http://localhost:8080")
    print("=" * 50)

if __name__ == "__main__":
    main()
