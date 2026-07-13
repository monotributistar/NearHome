#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# NearHome GPU Node — Deploy remoto desde macOS
# Usa Docker context para gestionar la Linux box transparentemente
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTEXT_NAME="${1:-gpu-node}"
GPU_SSH_HOST="${2:-}"

echo "=========================================="
echo " NearHome GPU Node Deploy"
echo " Context: $CONTEXT_NAME"
echo "=========================================="

# ─── 1. Crear contexto Docker si no existe ────────────────────────────
if ! docker context inspect "$CONTEXT_NAME" &>/dev/null; then
  if [ -z "$GPU_SSH_HOST" ]; then
    echo "❌ El contexto '$CONTEXT_NAME' no existe."
    echo "   Crearlo primero:"
    echo "   docker context create $CONTEXT_NAME --docker 'host=ssh://user@<IP_LINUX>'"
    echo ""
    echo "   O pasar el SSH host como segundo argumento:"
    echo "   $0 gpu-node usuario@100.x.x.x"
    exit 1
  fi
  echo "🔗 Creando contexto Docker '$CONTEXT_NAME' → $GPU_SSH_HOST..."
  docker context create "$CONTEXT_NAME" --docker "host=ssh://$GPU_SSH_HOST"
fi

echo "✅ Contexto: $(docker --context "$CONTEXT_NAME" info --format '{{.Name}}')"

# ─── 2. Verificar GPU disponible ──────────────────────────────────────
echo "🎮 Verificando GPU..."
GPU_INFO=$(docker --context "$CONTEXT_NAME" run --rm --gpus all ubuntu:24.04 \
  bash -c "apt update -qq >/dev/null 2>&1 && apt install -y -qq nvidia-utils-550 >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader" 2>/dev/null)

if [ -n "$GPU_INFO" ]; then
  echo "✅ GPU detectada: $GPU_INFO"
else
  echo "⚠️  No se detectó GPU. ¿Está instalado nvidia-container-toolkit?"
fi

# ─── 3. Transferir .env si no existe ──────────────────────────────────
cd "$REPO_DIR"
if [ ! -f infra/.env ]; then
  if [ -f infra/docker-compose.gpu.env.example ]; then
    cp infra/docker-compose.gpu.env.example infra/.env
    echo "⚠️  Completá infra/.env con las IPs de Tailscale y corré de nuevo"
    exit 0
  fi
fi

# ─── 4. Build + Deploy ────────────────────────────────────────────────
echo "🏗️  Build de imágenes..."
docker --context "$CONTEXT_NAME" compose -f infra/docker-compose.gpu.yml build

echo "🚀 Deploy a $CONTEXT_NAME..."
docker --context "$CONTEXT_NAME" compose -f infra/docker-compose.gpu.yml up -d

echo ""
echo "=========================================="
echo "✅ Deploy completado!"
echo "=========================================="
echo ""

# ─── 5. Verificar ─────────────────────────────────────────────────────
echo "📊 Contenedores en GPU node:"
docker --context "$CONTEXT_NAME" ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "📊 Nodos registrados en inference-bridge (macOS):"
echo "   curl -s http://localhost:8080/infer/v1/nodes | python3 -m json.tool"

echo ""
echo "📊 Logs en vivo:"
echo "   docker --context $CONTEXT_NAME logs -f nearhome-gpu-node-inference-node-yolo-1"
