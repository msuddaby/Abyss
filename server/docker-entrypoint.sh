#!/bin/bash
set -e

# Create upload directories if they don't exist
mkdir -p /app/uploads/servers
mkdir -p /app/uploads/dms
mkdir -p /app/uploads/misc
mkdir -p /app/wwwroot/uploads/emojis

# Ensure proper permissions (only if we have write access)
# This handles both first-time setup and existing volumes
chmod -R 755 /app/uploads 2>/dev/null || true
chmod -R 755 /app/wwwroot/uploads 2>/dev/null || true

# Execute the main application
exec "$@"
