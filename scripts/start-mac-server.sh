#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node server/check-env.js

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-7330}"

echo
echo "Starting Gama Music on port ${PORT}."
echo "Keep this window open while listening on iPhone."
echo

node server/server.js
