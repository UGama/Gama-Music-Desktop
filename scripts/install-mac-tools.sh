#!/usr/bin/env bash
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required to install yt-dlp and ffmpeg automatically."
  echo "Install Homebrew first from https://brew.sh/"
  exit 1
fi

brew install yt-dlp ffmpeg
