#!/bin/bash
# Build the wayland-idle-helper binary for Linux idle detection.
# Requires: wayland-scanner, gcc, libwayland-client (dev headers)
# No-ops on non-Linux platforms.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Skipping wayland-idle-helper build (not Linux)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../resources/bin"
cd "$BIN_DIR"

# Check for required tools
if ! command -v wayland-scanner &>/dev/null; then
  echo "WARNING: wayland-scanner not found — skipping wayland-idle-helper build"
  echo "  Install: apt install libwayland-dev / pacman -S wayland"
  exit 0
fi

if ! pkg-config --exists wayland-client 2>/dev/null; then
  echo "WARNING: wayland-client not found — skipping wayland-idle-helper build"
  echo "  Install: apt install libwayland-dev / pacman -S wayland"
  exit 0
fi

echo "Generating protocol bindings..."
wayland-scanner client-header idle-notify.xml ext-idle-notify-v1-client-protocol.h
wayland-scanner private-code  idle-notify.xml ext-idle-notify-v1-client-protocol.c

echo "Compiling wayland-idle-helper..."
gcc -Wall -Wextra -O2 -o wayland-idle-helper \
    wayland-idle-helper.c ext-idle-notify-v1-client-protocol.c \
    $(pkg-config --cflags --libs wayland-client)

# Clean up generated files
rm -f ext-idle-notify-v1-client-protocol.h ext-idle-notify-v1-client-protocol.c

echo "Built: $BIN_DIR/wayland-idle-helper"
