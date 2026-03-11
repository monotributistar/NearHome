#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRISMA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_SCHEMA="${PRISMA_DIR}/schema.prisma"
TARGET_SCHEMA="${PRISMA_DIR}/schema.postgres.prisma"

sed 's/provider = "sqlite"/provider = "postgresql"/' "${SOURCE_SCHEMA}" > "${TARGET_SCHEMA}"
