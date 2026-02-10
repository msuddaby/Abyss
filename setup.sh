#!/bin/bash
set -e

echo "Setting up Abyss development environment..."

# Create necessary directories
echo "Creating upload directories..."
mkdir -p data/uploads
mkdir -p data/uploads-files

# Set ownership to the container user (UID 1654 for .NET containers)
# This is more secure than using 777 permissions
echo "Setting secure permissions..."
sudo chown -R 1654:1654 data/uploads data/uploads-files
chmod -R 755 data/uploads data/uploads-files

echo "✓ Upload directories created and configured"
echo ""
echo "You can now run: docker compose up -d"
