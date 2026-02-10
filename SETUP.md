# Abyss Setup Guide

## First-Time Setup

### Quick Start

Run the setup script to create necessary directories with proper permissions:

```bash
./setup.sh
```

Then start the application:

```bash
docker compose up -d
```

### What the setup script does

1. Creates `data/uploads` and `data/uploads-files` directories
2. Sets ownership to the container user (UID 1654) with secure 755 permissions
3. These directories are mounted as volumes in the Docker containers for persistent storage

### Manual Setup

If you prefer to set up manually:

```bash
mkdir -p data/uploads data/uploads-files
sudo chown -R 1654:1654 data/uploads data/uploads-files
chmod -R 755 data/uploads data/uploads-files
```

## Why is this needed?

The API container runs as a non-root user for security. When Docker mounts host directories as volumes, they need write permissions for the container user. The setup script ensures these directories exist with the correct permissions before the container starts.

## Troubleshooting

### "Access to the path '/app/uploads/servers' is denied"

This error means the upload directories don't have proper permissions. Run:

```bash
sudo chown -R 1654:1654 data/uploads data/uploads-files
chmod -R 755 data/uploads data/uploads-files
docker compose restart api
```

### Starting fresh

To reset all uploaded data:

```bash
docker compose down
rm -rf data/
./setup.sh
docker compose up -d
```
