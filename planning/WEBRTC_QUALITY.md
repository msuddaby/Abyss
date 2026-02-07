# WebRTC Quality Controls - Future Consideration

## Overview

WebRTC quality is highly configurable through constraints and encoding parameters. This document outlines potential quality control features for voice and screen sharing.

## Current Implementation

**No explicit quality controls** - using browser defaults:
- Audio: Opus codec, adaptive ~32-64 kbps
- Screen share: Browser defaults (typically 720p-1080p, ~1-2 Mbps)
- No user-facing quality settings

## Quality Control Options

### 1. Audio Quality

**getUserMedia Constraints:**
```javascript
await navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 48000,        // Higher = better quality
    channelCount: 2,          // Stereo vs mono
  }
});
```

**Sender Bitrate Control:**
```javascript
const audioSender = pc.getSenders().find(s => s.track.kind === 'audio');
const params = audioSender.getParameters();
params.encodings[0].maxBitrate = 128000; // 128 kbps
await audioSender.setParameters(params);
```

**Audio Quality Ranges:**
- Voice (low): 32 kbps
- Voice (high): 64-128 kbps
- Music/stereo: 128-510 kbps

### 2. Video/Screen Share Quality

**getDisplayMedia Constraints:**
```javascript
await navigator.mediaDevices.getDisplayMedia({
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 60 }
  },
  audio: true
});
```

**Sender Encoding Parameters:**
```javascript
const videoSender = pc.getSenders().find(s => s.track.kind === 'video');
const params = videoSender.getParameters();
params.encodings[0].maxBitrate = 2500000;  // 2.5 Mbps
params.encodings[0].maxFramerate = 30;
params.encodings[0].scaleResolutionDownBy = 1; // 1 = no downscaling
await videoSender.setParameters(params);
```

**Video Quality Ranges:**
- Low (480p): 500-800 kbps
- Medium (720p): 1-1.5 Mbps
- High (1080p): 2-4 Mbps
- Very High (1080p60): 4-8 Mbps

## Critical Implications

### Mesh Topology Bandwidth Constraints

**⚠️ CRITICAL:** Our app uses mesh topology where each participant sends streams directly to every other participant.

**Upload bandwidth requirements:**
- 3 participants + 2 Mbps screen share = **4 Mbps upload**
- 5 participants + 2 Mbps screen share = **8 Mbps upload**
- 10 participants + 2 Mbps screen share = **18 Mbps upload**

**Why Discord/Zoom scale better:** They use SFU (Selective Forwarding Unit) servers where:
- Each participant uploads once to the server (2 Mbps)
- Server forwards to all other participants
- Scales linearly instead of exponentially

### CPU Usage
- High-quality video encoding is CPU-intensive
- Screen sharing 1080p60 video can max out CPUs
- Mobile devices struggle with high-quality encoding
- Multiple simultaneous sharers amplify CPU load

### Network Conditions
- Packet loss degrades quality significantly
- Higher bitrate = more sensitive to network issues
- WebRTC auto-adapts but can struggle in poor conditions
- Jitter and latency increase with higher bitrates

### Mobile Considerations
- High quality drains data plans: 2 Mbps = 900 MB/hour
- Battery drain from encoding/decoding
- Mobile CPUs throttle under sustained load
- Limited upload bandwidth on cellular

## Proposed Feature: Quality Settings

### User-Facing Settings

Add to voice settings modal:
```typescript
interface VoiceQualitySettings {
  qualityPreset: 'auto' | 'low' | 'medium' | 'high';
  screenShareMode: 'text' | 'video'; // Optimize for text vs motion
}
```

### Quality Presets

**Low (Mobile/Data Saver):**
- Screen share: 720p, 15fps, 800 kbps
- Voice: 32 kbps, mono
- Use case: Mobile data, poor network, battery saving

**Medium (Default):**
- Screen share: 1080p, 30fps, 1.5 Mbps
- Voice: 64 kbps, mono
- Use case: Standard desktop usage

**High (Desktop/WiFi):**
- Screen share: 1080p, 30fps, 2.5 Mbps
- Voice: 128 kbps, stereo
- Use case: High-quality presentations, good network

**Auto (Adaptive):**
- Start at Medium
- Monitor `RTCPeerConnection.getStats()` for:
  - Packet loss rate
  - Round-trip time (RTT)
  - Available bandwidth estimates
- Dynamically adjust bitrate down if network struggling
- Gradually increase back when conditions improve

### Screen Share Profiles

**Optimize for Text/Code (Default):**
- Higher resolution, lower framerate (1080p @ 15fps)
- Better for static content, documents, code
- Lower bandwidth usage

**Optimize for Video/Motion:**
- Balanced resolution, higher framerate (720p @ 30fps)
- Better for watching videos, gaming, animations
- Smoother motion

## Implementation Plan

### Phase 1: Basic Quality Presets
1. Add `qualityPreset` to voiceStore (persisted to localStorage)
2. Create quality settings section in UserSettingsModal
3. Implement preset application in `startScreenShareInternal()`:
   - Set `getDisplayMedia` constraints
   - Apply sender parameters after track negotiation
4. Test bandwidth usage across presets
5. Add mobile-specific defaults (auto-select "low" on mobile)

### Phase 2: Screen Share Profiles
1. Add profile selector when starting screen share
2. Implement constraint profiles for text vs video optimization
3. Allow switching profile during active screen share (renegotiate)

### Phase 3: Adaptive Quality (Auto Mode)
1. Implement stats monitoring loop:
   ```javascript
   setInterval(async () => {
     const stats = await pc.getStats();
     stats.forEach(report => {
       if (report.type === 'outbound-rtp' && report.kind === 'video') {
         const packetLoss = report.packetsLost / report.packetsSent;
         const currentBitrate = report.bytesSent * 8 / report.timestamp;
         // Adjust based on conditions
       }
     });
   }, 5000);
   ```
2. Implement bitrate adjustment algorithm:
   - If packet loss > 5%: reduce bitrate by 20%
   - If RTT > 200ms: reduce bitrate by 10%
   - If stable for 30s: increase bitrate by 10% (up to preset max)
3. Add visual indicator when quality is being throttled
4. Log quality adjustments for debugging

### Phase 4: Connection Warnings
1. Add participant count warning (mesh topology limits)
2. Show warning at 5+ participants: "Voice quality may degrade"
3. Show error at 10+ participants: "Consider voice-only for large groups"
4. Add connection quality indicator (good/medium/poor)

## Advanced Considerations

### SFU Migration (Major Architecture Change)

If we want to support larger groups (10+ participants):

**Benefits:**
- Upload bandwidth scales linearly (always 1x bitrate)
- Supports 100+ participants
- Server can do bandwidth adaptation per viewer
- Can offer simulcast (multiple quality tiers)

**Drawbacks:**
- Requires hosting SFU server (mediasoup, Janus, Jitsi, etc.)
- Added complexity and infrastructure cost
- Server becomes single point of failure
- Additional latency hop

**Open Source SFU Options:**
- [mediasoup](https://mediasoup.org/) (Node.js)
- [Janus Gateway](https://janus.conf.meetecho.com/) (C)
- [Jitsi Videobridge](https://jitsi.org/jitsi-videobridge/) (Java)
- [LiveKit](https://livekit.io/) (Go, hosted or self-hosted)

### Simulcast

Send multiple quality levels simultaneously, let receiver choose:
```javascript
pc.addTransceiver(track, {
  streams: [stream],
  sendEncodings: [
    { rid: 'high', maxBitrate: 2500000 },
    { rid: 'medium', maxBitrate: 1000000, scaleResolutionDownBy: 2 },
    { rid: 'low', maxBitrate: 500000, scaleResolutionDownBy: 4 }
  ]
});
```

**Requires SFU** - mesh topology can't benefit from simulcast.

## UI Mockups

### User Settings Modal - Voice Tab

```
Voice Settings
├── Input Device: [Dropdown]
├── Output Device: [Dropdown]
├── Voice Mode: (•) Voice Activity  ( ) Push to Talk
└── Quality Settings
    ├── Quality Preset: [Low | Medium | High | Auto] ← NEW
    ├── Screen Share Mode: [Optimize for Text | Optimize for Video] ← NEW
    └── ℹ️ Higher quality uses more bandwidth and CPU
```

### Voice Channel - Connection Stats (Dev/Debug)

```
🔊 General Voice
├── 👤 User 1 (you) 🎤
│   └── 📊 Sending: 1.2 Mbps | Packet loss: 0.5%
├── 👤 User 2 🖥️ LIVE
│   └── 📊 Receiving: 1.8 Mbps | RTT: 45ms
└── ⚠️ 5 participants - consider voice-only for large groups
```

## Testing Strategy

### Performance Benchmarks
- Test with 2, 3, 5, 8, 10 participants
- Measure CPU usage per quality preset
- Measure bandwidth usage per quality preset
- Measure packet loss under bandwidth constraints

### Network Simulation
- Use Chrome DevTools network throttling
- Test: Fast 3G, Slow 3G, Offline
- Verify auto quality adaptation behavior

### Device Testing
- Test on low-end mobile devices (old iPhones, budget Android)
- Test on various desktop CPUs
- Verify mobile data usage warnings

## References

- [WebRTC API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [RTCRtpSender.setParameters()](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)
- [getDisplayMedia Constraints](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [WebRTC Stats API](https://developer.mozilla.org/en-US/docs/Web/API/RTCStatsReport)

## Decision: Future Consideration

**Status:** Documented, not implemented

**Reasoning:**
- Current default quality is acceptable for MVP
- Mesh topology limits scale regardless of quality settings
- Adds UI complexity
- If scaling becomes an issue, SFU migration is more impactful

**Reconsider when:**
- Users report quality issues or bandwidth problems
- Expanding to larger group voice channels (10+ users)
- Mobile users report excessive data usage
- Adding recorded streams or broadcast features
