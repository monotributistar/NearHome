#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# NearHome GPU Node — Bootstrap script
# Ejecutar EN LA LINUX BOX para preparar Docker + NVIDIA + Tailscale
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "=========================================="
echo " NearHome GPU Node Bootstrap"
echo " Linux + RTX 3060"
echo "=========================================="

# ─── 1. Verificar sistema ─────────────────────────────────────────────
OS="$(uname -s)"
if [ "$OS" != "Linux" ]; then
  echo "❌ Este script es para Linux (ejecutalo en la GPU box)"
  exit 1
fi

echo "✅ Sistema: $(lsb_release -ds 2>/dev/null || echo Linux)"

# ─── 2. Docker ────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "📦 Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "⚠️  Cerrá sesión y volvé a entrar para usar docker sin sudo"
else
  echo "✅ Docker: $(docker --version)"
fi

# ─── 3. NVIDIA Driver ─────────────────────────────────────────────────
if ! command -v nvidia-smi &>/dev/null; then
  echo "🎮 Instalando NVIDIA driver..."
  sudo apt update
  sudo apt install -y nvidia-driver-550 nvidia-utils-550
  echo "⚠️  Reiniciá para que el driver cargue (o ejecutá: sudo modprobe nvidia)"
else
  echo "🎮 NVIDIA driver detectado:"
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
fi

# ─── 4. NVIDIA Container Toolkit ──────────────────────────────────────
if ! docker info 2>/dev/null | grep -q nvidia; then
  echo "🐋 Instalando NVIDIA Container Toolkit..."
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
    sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt update && sudo apt install -y nvidia-container-toolkit
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
  echo "✅ NVIDIA Container Toolkit instalado"
else
  echo "✅ NVIDIA Container Toolkit: presente"
fi

# ─── 5. Verificar GPU en Docker ───────────────────────────────────────
echo "🐋 Verificando GPU en Docker..."
docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi 2>/dev/null || \
  docker run --rm --gpus all ubuntu:24.04 bash -c "apt update -qq && apt install -y -qq nvidia-utils-550 && nvidia-smi" || \
  echo "⚠️  No se pudo verificar GPU en Docker. Revisá nvidia-ctk."

# ─── 6. Tailscale ─────────────────────────────────────────────────────
if ! command -v tailscale &>/dev/null; then
  echo "🔗 Instalando Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
  echo "⚠️  Ejecutá 'sudo tailscale up' para conectar a la tailnet"
else
  echo "🔗 Tailscale: $(tailscale status --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("Self",{}).get("TailscaleIPs",["?"])[0])' 2>/dev/null || echo instalado)"
fi

# ─── 7. Git + clone del repo ──────────────────────────────────────────
if [ ! -d "$HOME/NearHome" ]; then
  echo "📂 Clonando NearHome..."
  git clone https://github.com/monotributistar/NearHome.git "$HOME/NearHome"
  cd "$HOME/NearHome"
  git checkout claude/deployments-fleet-manifest
else
  echo "📂 NearHome ya clonado en $HOME/NearHome"
fi

echo ""
echo "=========================================="
echo "✅ Bootstrap completo!"
echo "=========================================="
echo ""
echo "Próximos pasos:"
echo "  1. sudo tailscale up           # conectar a la tailnet"
echo "  2. tailscale ip -4            # obtener IP del nodo GPU"
echo "  3. cd ~/NearHome/infra"
echo "  4. cp docker-compose.gpu.env.example .env"
echo "  5. nano .env                  # completar IPs de Tailscale"
echo "  6. docker compose -f docker-compose.gpu.yml up -d"
echo ""
echo "En macOS:"
echo "  docker context create gpu-node --docker 'host=ssh://user@<IP_LINUX>'"
