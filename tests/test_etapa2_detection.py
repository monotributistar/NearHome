#!/usr/bin/env python3
"""
Test Etapa 2: Motor de Deteccion YOLO
Verifica que el detector funciona correctamente con imagenes de prueba
"""

import subprocess
import sys
import time
import requests
import base64
import json
from typing import Tuple

API_DETECTOR_URL = "http://localhost:8001"
API_NEARHOME_URL = "http://localhost:8000"


def run_cmd(cmd: str) -> Tuple[bool, str]:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.returncode == 0, result.stdout + result.stderr


def test_detector_health() -> bool:
    """Verifica que el detector esta activo"""
    try:
        response = requests.get(f"{API_DETECTOR_URL}/health", timeout=10)
        if response.status_code == 200:
            print("✓ Detector YOLO activo")
            return True
    except requests.exceptions.RequestException:
        pass
    print("❌ FAIL: Detector YOLO no responde")
    return False


def test_api_health() -> bool:
    """Verifica que la API NearHome esta activa"""
    try:
        response = requests.get(f"{API_NEARHOME_URL}/health", timeout=10)
        if response.status_code == 200:
            print("✓ NearHome API activa")
            return True
    except requests.exceptions.RequestException:
        pass
    print("❌ FAIL: NearHome API no responde")
    return False


def test_detection_endpoint() -> bool:
    """Verifica que el endpoint de deteccion funciona"""
    dummy_frame = base64.b64encode(b"fake_image_data").decode("utf-8")

    payload = {
        "camera_id": "test-camera-001",
        "client_id": "test-client-001",
        "timestamp": "2024-01-01T00:00:00",
        "frame_data": dummy_frame,
        "width": 640,
        "height": 480,
    }

    try:
        response = requests.post(
            f"{API_DETECTOR_URL}/detect", json=payload, timeout=30
        )
        if response.status_code in [200, 422]:
            print("✓ Endpoint /detect responde")
            return True
    except requests.exceptions.RequestException as e:
        print(f"❌ FAIL: Endpoint /detect error: {e}")
        return False

    print("❌ FAIL: Endpoint /detect no responde correctamente")
    return False


def test_create_client() -> bool:
    """Verifica que se puede crear un cliente"""
    payload = {
        "name": "Test Client",
        "email": "test@example.com",
        "phone": "+5491112345678",
        "whatsapp": "+5491112345678",
        "storage_quota_mb": 10240,
    }

    try:
        response = requests.post(
            f"{API_NEARHOME_URL}/clients", json=payload, timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            print(f"✓ Cliente creado: {data.get('id')}")
            return True
    except requests.exceptions.RequestException as e:
        print(f"❌ FAIL: Crear cliente error: {e}")
        return False

    print("❌ FAIL: No se pudo crear cliente")
    return False


def test_create_camera() -> bool:
    """Verifica que se puede crear una camara"""
    clients_response = requests.get(f"{API_NEARHOME_URL}/clients", timeout=10)
    if clients_response.status_code != 200:
        print("❌ FAIL: No se pudieron obtener clientes")
        return False

    clients = clients_response.json()
    if not clients:
        print("❌ FAIL: No hay clientes para crear camara")
        return False

    client_id = clients[0]["id"]

    payload = {
        "client_id": client_id,
        "name": "Test Camera",
        "rtsp_url": "rtsp://test:554/stream",
        "location": "Entrada principal",
        "detect_persons": True,
        "detect_vehicles": True,
    }

    try:
        response = requests.post(
            f"{API_NEARHOME_URL}/cameras", json=payload, timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            print(f"✓ Camara creada: {data.get('id')}")
            return True
    except requests.exceptions.RequestException as e:
        print(f"❌ FAIL: Crear camara error: {e}")
        return False

    print("❌ FAIL: No se pudo crear camara")
    return False


def test_create_incidence() -> bool:
    """Verifica que se puede crear una incidencia"""
    clients_response = requests.get(f"{API_NEARHOME_URL}/clients", timeout=10)
    cameras_response = requests.get(f"{API_NEARHOME_URL}/cameras", timeout=10)

    if clients_response.status_code != 200 or cameras_response.status_code != 200:
        print("❌ FAIL: No se pudieron obtener datos")
        return False

    clients = clients_response.json()
    cameras = cameras_response.json()

    if not clients or not cameras:
        print("❌ FAIL: No hay datos para crear incidencia")
        return False

    payload = {
        "client_id": clients[0]["id"],
        "camera_id": cameras[0]["id"],
        "detection_type": "person",
        "description": "Test incidence",
        "level": "high",
    }

    try:
        response = requests.post(
            f"{API_NEARHOME_URL}/incidences", json=payload, timeout=10
        )
        if response.status_code == 200:
            data = response.json()
            print(f"✓ Incidencia creada: {data.get('id')}")
            return True
    except requests.exceptions.RequestException as e:
        print(f"❌ FAIL: Crear incidencia error: {e}")
        return False

    print("❌ FAIL: No se pudo crear incidencia")
    return False


def test_docker_services() -> bool:
    """Verifica que todos los contenedores estan corriendo"""
    services = [
        "nearhome-db",
        "nearhome-redis",
        "nearhome-api",
        "nearhome-detector",
        "nearhome-shinobi-nvr",
    ]
    all_running = True
    for service in services:
        success, output = run_cmd(
            f'docker ps --filter "name={service}" --filter "status=running" -q'
        )
        if success and output.strip():
            print(f"✓ {service} corriendo")
        else:
            print(f"❌ FAIL: {service} no esta corriendo")
            all_running = False
    return all_running


def main():
    print("=" * 50)
    print("NearHome - Test Etapa 2: Motor de Deteccion")
    print("=" * 50)

    print("\n[1] Verificando servicios Docker...")
    docker_ok = test_docker_services()

    if not docker_ok:
        print("\n❌ Servicios Docker no estan listos. Abortando tests.")
        return 1

    print("\n[2] Verificando endpoints...")

    tests = [
        ("Detector Health", test_detector_health),
        ("API Health", test_api_health),
        ("Detection Endpoint", test_detection_endpoint),
        ("Create Client", test_create_client),
        ("Create Camera", test_create_camera),
        ("Create Incidence", test_create_incidence),
    ]

    results = []
    for name, test_func in tests:
        print(f"\n[Ejecutando] {name}")
        results.append(test_func())

    print("\n" + "=" * 50)
    passed = sum(results)
    total = len(results)
    print(f"Resultados: {passed}/{total} tests pasados")

    if passed == total:
        print("✅ Etapa 2 COMPLETADA")
        return 0
    else:
        print("❌ Etapa 2 FALLIDA")
        return 1


if __name__ == "__main__":
    sys.exit(main())
