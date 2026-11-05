#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GENERATED_DIR="$ROOT_DIR/server/generated"
mkdir -p "$GENERATED_DIR"
touch "$GENERATED_DIR/__init__.py"

"$ROOT_DIR/server/.venv/bin/python" -m grpc_tools.protoc \
  -I "$ROOT_DIR/src/protos" \
  --python_out="$GENERATED_DIR" \
  --grpc_python_out="$GENERATED_DIR" \
  "$ROOT_DIR/src/protos/base_search.proto" \
  "$ROOT_DIR/src/protos/database_all.proto"
