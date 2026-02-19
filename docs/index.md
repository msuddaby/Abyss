---
layout: home

hero:
  name: Abyss
  text: Self-Hosted Chat, Your Rules
  tagline: Text, voice, video, screen sharing, and watch parties — on infrastructure you own.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/msuddaby/Abyss

features:
  - icon: 💬
    title: Rich Messaging
    details: Real-time chat with replies, reactions, mentions, pins, file attachments, and full message history search.
  - icon: 🔊
    title: Hybrid Voice & Video
    details: WebRTC peer-to-peer by default with TURN traversal. Automatic LiveKit SFU fallback for large groups or restrictive networks.
  - icon: 🔐
    title: End-to-End Encrypted Relay
    details: All SFU relay traffic is encrypted AES-GCM-256 via PBKDF2 — the relay server never sees plaintext audio or video.
  - icon: 🎬
    title: Watch Parties
    details: Synchronized playback sessions with queue management and host controls. Supports YouTube and linked Plex servers.
  - icon: 🧩
    title: Roles & Permissions
    details: Custom roles with a bitfield permission system and per-channel overrides. Full moderation controls including bans and voice moderation.
  - icon: 📱
    title: Multi-Platform
    details: Web app, iOS and Android via Capacitor, and a native Electron desktop app with auto-updates and global push-to-talk keybinds.
  - icon: 🛎️
    title: Notifications
    details: In-app notifications with per-server and per-channel overrides. Optional Firebase mobile push for iOS and Android.
  - icon: 🏠
    title: True Self-Hosting
    details: You own your data, auth, storage, and deployment. Four-container Docker Compose stack with a Caddy reverse proxy for zero-config HTTPS.
---

## What is Abyss?

Abyss is an open-source, self-hosted chat platform with the feature set of a managed service and the control of self-hosting. It runs as a Docker Compose stack — a PostgreSQL database, an ASP.NET Core API, a coturn TURN server, and an optional LiveKit SFU — behind a Caddy reverse proxy that handles TLS automatically.

The web client is built with React 19 and TypeScript. The same codebase powers iOS and Android apps via Capacitor, and an Electron desktop app with desktop-specific integrations (global push-to-talk, system idle detection, and auto-updates).

## Documentation Map

| Guide | Description |
|---|---|
| [Getting Started](/getting-started) | Set up a local development environment |
| [Features](/features) | Complete feature inventory by product area |
| [Development Workflow](/development) | Monorepo layout, commands, and day-to-day iteration |
| [Configuration](/configuration) | All environment variables with descriptions and examples |
| [Deployment](/deployment) | Production setup with Docker, Caddy, TURN, and LiveKit |
| [Architecture](/architecture) | System design, component overview, and data flow |
| [API Overview](/api-overview) | REST endpoint groups and SignalR hub events |
| [Voice Architecture](/VOICE_ARCHITECTURE) | Deep dive into P2P, TURN traversal, SFU relay, and E2EE |
| [Contributing](/contributing) | How to contribute features, fixes, and docs |
| [Troubleshooting](/troubleshooting) | Common issues and solutions |
