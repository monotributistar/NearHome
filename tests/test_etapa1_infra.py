#!/usr/bin/env python3
"""
Test Etapa 1: Infraestructura Base
Verifica que todos los servicios estan corriendo y accesibles
"""

import subprocess
import sys
import time
import requests
from typing import Tuple

def run_cmd(cmd: str) -> Tuple[bool, str]:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.returncode == 0, result.stdout + result.stderr

def test_docker_services() -> bool:
    """Verifica que todos los contenedores estan corriendo"""
    success, output = run_cmd("docker-compose ps -q")
    if not success:
        print("❌ FAIL: No se pueden listar contenedores")
        return False
    
    services = ["nearhome-db", "nearhome-redis", "nearhome-shinobi"]
    for service in services:
        success, output = run_cmd(f"docker ps --filter name={service} --filter status=running -q")
        if not success or not output.strip():
            print(f"❌ FAIL: {service} no esta corriendo")
            return False
        print(f"✓ {service} corriendo")
    return True

def test_mariadb_connection() -> bool:
    """Verifica conexion a MariaDB"""
    cmd = 'docker exec nearhome-db mariadb -umajesticflame -pnearhome_pass_2024 -e "SELECT 1"'
    success, output = run_cmd(cmd)
    if not success:
        print("❌ FAIL: No se puede conectar a MariaDB")
        return False
    print("✓ MariaDB conectable")
    return True

def test_redis_connection() -> bool:
    """Verifica conexion a Redis"""
    cmd = 'docker exec nearhome-redis redis-cli ping'
    success, output = run_cmd(cmd)
    if not success or "PONG" not in output:
        print("❌ FAIL: No se puede conectar a Redis")
        return False
    print("✓ Redis conectable")
    return True

def test_shinobi_web() -> bool:
    """Verifica que Shinobi responde en puerto 8080"""
    max_retries = 10
    for i in range(max_retries):
        try:
            response = requests.get("http://localhost:8080", timeout=5)
            if response.status_code == 200:
                print("✓ Shinobi web accesible")
                return True
        except requests.exceptions.RequestException:
            print(f"  Esperando Shinobi... ({i+1}/{max_retries})")
            time.sleep(5)
    print("❌ FAIL: Shinobi no responde en puerto 8080")
    return False

def main():
    print("=" * 50)
    print("NearHome - Test Etapa 1: Infraestructura Base")
    print("=" * 50)
    
    tests = [
        ("Docker Services", test_docker_services),
        ("MariaDB Connection", test_mariadb_connection),
        ("Redis Connection", test_redis_connection),
        ("Shinobi Web", test_shinobi_web),
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
        print("✅ Etapa 1 COMPLETADA")
        return 0
    else:
        print("❌ Etapa 1 FALLIDA")
        return 1

if __name__ == "__main__":
    sys.exit(main())
