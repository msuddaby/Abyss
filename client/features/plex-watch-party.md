# Watch Party Feature (Multi-Provider)

## Overview
Allow server owners to connect media providers (Plex, YouTube, Spotify, etc.) and host synchronized watch parties in voice channels. Each client streams directly from the provider while the Abyss backend handles playback synchronization via SignalR.

**Supported Providers (Planned):**
- **Plex** - Self-hosted media servers (movies, TV shows, music)
- **YouTube** - Public videos via YouTube API
- **Spotify** - Music streaming (requires Premium for all users)
- **Twitch** - Live streams
- **SoundCloud** - Music and podcasts
- _Easily extensible to other providers_

## Architecture

### Video Streaming Flow
```
Media Provider ←→ Client 1 (direct stream)
(Plex/YouTube)  ←→ Client 2 (direct stream)
                ←→ Client 3 (direct stream)

Abyss Backend ←→ All Clients (sync signals only)
```

**Key Principle:** Abyss infrastructure only handles authentication, library browsing, and playback synchronization. Media streams directly from the provider to clients.

### Provider Abstraction Layer

```
┌─────────────────────────────────────────────┐
│           IMediaProvider Interface          │
│  - Authenticate()                           │
│  - GetLibraries() / Search()                │
│  - GetPlaybackUrl()                         │
│  - GetMetadata()                            │
└─────────────────────────────────────────────┘
                    ↑
        ┌───────────┼───────────┬──────────────┐
        │           │           │              │
┌───────────┐ ┌──────────┐ ┌─────────┐ ┌─────────────┐
│   Plex    │ │ YouTube  │ │ Spotify │ │   Twitch    │
│ Provider  │ │ Provider │ │Provider │ │  Provider   │
└───────────┘ └──────────┘ └─────────┘ └─────────────┘
```

Controllers and services interact only with `IMediaProvider`, never directly with provider-specific implementations. Adding a new provider requires:
1. Implement `IMediaProvider` interface
2. Register in provider factory
3. Add provider-specific settings (if needed)
4. Add frontend player adapter (if non-standard)

**No changes to core watch party logic required.**

---

## Scalability Summary

### Why This Architecture Scales

**Problem:** Every media provider has different:
- Authentication flows (username/password, API keys, OAuth)
- Content structures (libraries vs playlists vs channels)
- Playback methods (direct URLs, embed iframes, SDK players)
- Metadata formats

**Solution:** Abstraction layer with two interfaces:
1. **`IMediaProvider`** (backend) - Normalizes all provider differences
2. **`PlayerAdapter`** (frontend) - Standardizes playback control

### Adding a New Provider: Effort Breakdown

| Task | Effort | Files Modified |
|------|--------|----------------|
| Implement `IMediaProvider` | 1-2 hours | 1 new file |
| Implement `PlayerAdapter` | 1-2 hours | 1 new file |
| Register in factories | 5 minutes | 2 files |
| Update enums/types | 5 minutes | 2 files |
| **Total** | **~3-5 hours** | **6 files** |

**Core watch party code touched:** 0 files

### Future-Proof Design

Want to add:
- **SoundCloud?** Implement 2 classes, register in factory
- **Apple Music?** Implement 2 classes, register in factory
- **Custom streaming server?** Implement 2 classes, register in factory
- **Mix-and-match queue** (Plex video → YouTube video → Spotify song)? Already supported (queue stores `providerItemId` + `providerType`)

The architecture is **open for extension, closed for modification.**

---

## Data Models

### Backend (ASP.NET)

**MediaProviderType** (Enum)
```csharp
public enum MediaProviderType
{
    Plex = 1,
    YouTube = 2,
    Spotify = 3,
    Twitch = 4,
    SoundCloud = 5
    // Easy to extend...
}
```

**MediaProviderConnection**
```csharp
public class MediaProviderConnection
{
    public long Id { get; set; }
    public long ServerId { get; set; }  // Abyss server this is linked to
    public long OwnerId { get; set; }   // User who linked it
    public MediaProviderType ProviderType { get; set; }
    public string DisplayName { get; set; }  // User-friendly name

    // Provider-specific config (encrypted JSON)
    // For Plex: { "serverUrl": "...", "authToken": "...", "machineId": "..." }
    // For YouTube: { "apiKey": "...", "channelId": "..." }
    // For Spotify: { "refreshToken": "...", "userId": "..." }
    public string ProviderConfigJson { get; set; }  // Encrypted

    public DateTime LinkedAt { get; set; }
    public DateTime? LastSyncAt { get; set; }

    public Server Server { get; set; }
    public User Owner { get; set; }
}
```

**WatchParty**
```csharp
public class WatchParty
{
    public long Id { get; set; }
    public long ChannelId { get; set; }
    public long MediaProviderConnectionId { get; set; }
    public long HostUserId { get; set; }

    // Current playback state (provider-agnostic)
    public string ProviderItemId { get; set; }  // Plex: "/library/metadata/123", YouTube: "dQw4w9WgXcQ"
    public string ItemTitle { get; set; }
    public string ItemThumbnail { get; set; }
    public long? ItemDurationMs { get; set; }  // Null for live streams
    public double CurrentTimeMs { get; set; }
    public bool IsPlaying { get; set; }
    public DateTime LastSyncAt { get; set; }

    // Queue (JSON array of { providerItemId, title, thumbnail, duration })
    public string QueueJson { get; set; }

    public Channel Channel { get; set; }
    public MediaProviderConnection MediaProviderConnection { get; set; }
    public User Host { get; set; }
}
```

**IMediaProvider** (Service Interface)
```csharp
public interface IMediaProvider
{
    MediaProviderType ProviderType { get; }

    // Authentication
    Task<ProviderAuthResult> AuthenticateAsync(Dictionary<string, string> credentials);
    Task<bool> ValidateConnectionAsync(string configJson);

    // Content browsing
    Task<List<MediaLibrary>> GetLibrariesAsync(string configJson);
    Task<List<MediaItem>> SearchItemsAsync(string configJson, string query, string? libraryId = null);
    Task<MediaItem> GetItemDetailsAsync(string configJson, string itemId);

    // Playback
    Task<PlaybackInfo> GetPlaybackInfoAsync(string configJson, string itemId, long? userId = null);

    // Metadata
    string GetProviderDisplayName();
    List<string> GetRequiredCredentialFields();  // e.g., ["username", "password"] or ["apiKey"]
}

public class MediaLibrary
{
    public string Id { get; set; }
    public string Name { get; set; }
    public string Type { get; set; }  // movie, show, music, playlist
}

public class MediaItem
{
    public string Id { get; set; }
    public string Title { get; set; }
    public string? Subtitle { get; set; }  // Artist, channel name, etc.
    public string? Thumbnail { get; set; }
    public long? DurationMs { get; set; }
    public string? Description { get; set; }
    public Dictionary<string, object>? Metadata { get; set; }  // Provider-specific
}

public class PlaybackInfo
{
    public string Url { get; set; }  // Direct playback URL
    public string? MimeType { get; set; }
    public bool RequiresAuth { get; set; }  // Does URL need auth headers?
    public Dictionary<string, string>? Headers { get; set; }  // Auth headers if needed
    public List<PlaybackQuality>? AvailableQualities { get; set; }
}

public class PlaybackQuality
{
    public string Label { get; set; }  // "1080p", "High", etc.
    public string Url { get; set; }
    public long? Bitrate { get; set; }
}

public class ProviderAuthResult
{
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }
    public string ConfigJson { get; set; }  // To store in MediaProviderConnection
    public string DisplayName { get; set; }  // Provider-specific display name
}
```

**Provider Implementations** (Examples)

```csharp
public class PlexMediaProvider : IMediaProvider
{
    public MediaProviderType ProviderType => MediaProviderType.Plex;

    public async Task<ProviderAuthResult> AuthenticateAsync(Dictionary<string, string> credentials)
    {
        // Authenticate with Plex API using username/password or token
        // Return config JSON: { "serverUrl": "...", "authToken": "...", "machineId": "..." }
    }

    public async Task<List<MediaLibrary>> GetLibrariesAsync(string configJson)
    {
        // Parse config, call Plex API /library/sections
    }

    public async Task<PlaybackInfo> GetPlaybackInfoAsync(string configJson, string itemId, long? userId)
    {
        // Get Plex stream URL for specific user
        // Return direct play or transcode URL
    }

    // ... implement other methods
}

public class YouTubeMediaProvider : IMediaProvider
{
    public MediaProviderType ProviderType => MediaProviderType.YouTube;

    public async Task<ProviderAuthResult> AuthenticateAsync(Dictionary<string, string> credentials)
    {
        // Validate YouTube API key
        // Return config JSON: { "apiKey": "..." }
    }

    public async Task<List<MediaItem>> SearchItemsAsync(string configJson, string query, string? libraryId)
    {
        // Use YouTube Data API v3 to search
        // Return video results
    }

    public async Task<PlaybackInfo> GetPlaybackInfoAsync(string configJson, string itemId, long? userId)
    {
        // Return YouTube embed URL or use youtube-dl approach
        // Note: Direct stream extraction may violate YouTube ToS
    }

    // ... implement other methods
}
```

**MediaProviderFactory**
```csharp
public class MediaProviderFactory
{
    private readonly Dictionary<MediaProviderType, IMediaProvider> _providers;

    public MediaProviderFactory(IServiceProvider serviceProvider)
    {
        _providers = new Dictionary<MediaProviderType, IMediaProvider>
        {
            { MediaProviderType.Plex, serviceProvider.GetRequiredService<PlexMediaProvider>() },
            { MediaProviderType.YouTube, serviceProvider.GetRequiredService<YouTubeMediaProvider>() },
            // Add new providers here...
        };
    }

    public IMediaProvider GetProvider(MediaProviderType type)
    {
        return _providers[type];
    }
}
```

## API Endpoints

### Provider Connection Management
```
GET    /api/servers/{serverId}/media-providers
  Response: [{ id, providerType, displayName, linkedBy, linkedAt }]

POST   /api/servers/{serverId}/media-providers/link
  Body: {
    providerType: "Plex" | "YouTube" | "Spotify" | ...,
    credentials: { /* provider-specific */ }
  }
  Examples:
    Plex: { username, password } OR { authToken }
    YouTube: { apiKey }
    Spotify: { clientId, clientSecret } (initiates OAuth flow)
  Response: { id, providerType, displayName }

GET    /api/media-providers/{connectionId}
  Response: { id, providerType, displayName, linkedBy, linkedAt }

DELETE /api/media-providers/{connectionId}
  Requires: Connection owner or server owner

GET    /api/media-providers/{connectionId}/validate
  Response: { isValid: boolean, error?: string }
```

### Content Browsing (Provider-Agnostic)
```
GET    /api/media-providers/{connectionId}/libraries
  Response: [{ id, name, type }]

GET    /api/media-providers/{connectionId}/search
  Query: ?query=search+terms&library={libraryId}
  Response: [{ id, title, subtitle, thumbnail, durationMs, description }]

GET    /api/media-providers/{connectionId}/item/{itemId}
  Response: { id, title, subtitle, thumbnail, durationMs, description, metadata }
  Note: itemId is URL-encoded (Plex: "/library/metadata/123", YouTube: "dQw4w9WgXcQ")
```

### Watch Party Control
```
POST   /api/channels/{channelId}/watch-party/start
  Body: { connectionId, providerItemId }
  Requires: In voice channel + Stream permission
  Response: {
    watchPartyId,
    providerType,
    providerItemId,
    title,
    thumbnail,
    durationMs,
    ...
  }

POST   /api/channels/{channelId}/watch-party/stop
  Requires: Host or Manage Channels permission

GET    /api/channels/{channelId}/watch-party
  Response: {
    watchPartyId,
    providerType,
    connectionId,
    providerItemId,
    title,
    thumbnail,
    durationMs,
    currentTimeMs,
    isPlaying,
    host,
    queue
  } | null

POST   /api/channels/{channelId}/watch-party/queue/add
  Body: { providerItemId }

POST   /api/channels/{channelId}/watch-party/queue/remove
  Body: { providerItemId }

POST   /api/channels/{channelId}/watch-party/queue/reorder
  Body: { fromIndex, toIndex }
```

### Playback URL (Per-User, Provider-Agnostic)
```
GET    /api/media-providers/{connectionId}/item/{itemId}/playback
  Response: {
    url,
    mimeType?,
    requiresAuth,
    headers?: { ... },
    availableQualities?: [{ label, url, bitrate }]
  }
  Note: Each user gets their own authenticated URL when needed
```

## SignalR Events

### Server → Client (voice group)

**WatchPartyStarted**
```json
{
  "channelId": 123,
  "watchPartyId": 456,
  "providerType": "Plex",  // or "YouTube", "Spotify", etc.
  "connectionId": 789,
  "providerItemId": "/library/metadata/12345",  // or "dQw4w9WgXcQ" for YouTube
  "title": "The Matrix",
  "thumbnail": "...",
  "durationMs": 8280000,  // null for live streams
  "hostUserId": 1
}
```

**WatchPartyStopped**
```json
{
  "channelId": 123
}
```

**PlaybackCommand**
```json
{
  "channelId": 123,
  "command": "play" | "pause" | "seek",
  "timeMs": 123456,  // current position
  "timestamp": "2024-01-01T12:00:00Z"  // when command was issued
}
```

**SyncPosition**
```json
{
  "channelId": 123,
  "timeMs": 123456,
  "isPlaying": true
}
```

**QueueUpdated**
```json
{
  "channelId": 123,
  "queue": [
    {
      "providerItemId": "...",
      "title": "...",
      "thumbnail": "...",
      "durationMs": 120000
    }
  ]
}
```

### Client → Server (hub methods)

```csharp
// In ChatHub
Task NotifyPlaybackCommand(long channelId, string command, double timeMs);
Task RequestSync(long channelId);  // Ask host for current position
Task ReportPlaybackPosition(long channelId, double timeMs, bool isPlaying);
```

## Frontend Components

### Types: `watchPartyTypes.ts`
```typescript
export type MediaProviderType = 'Plex' | 'YouTube' | 'Spotify' | 'Twitch' | 'SoundCloud';

export interface MediaProviderConnection {
  id: number;
  providerType: MediaProviderType;
  displayName: string;
  linkedBy: number;
  linkedAt: string;
}

export interface MediaItem {
  id: string;
  title: string;
  subtitle?: string;
  thumbnail?: string;
  durationMs?: number;
  description?: string;
}

export interface WatchParty {
  channelId: number;
  watchPartyId: number;
  providerType: MediaProviderType;
  connectionId: number;
  providerItemId: string;
  title: string;
  thumbnail?: string;
  durationMs?: number;
  hostUserId: number;
  currentTimeMs: number;
  isPlaying: boolean;
  queue: MediaItem[];
}
```

### Store: `watchPartyStore.ts`
```typescript
interface WatchPartyState {
  activeParty: WatchParty | null;

  // UI state
  isPlayerVisible: boolean;
  isBrowsingLibrary: boolean;

  // Actions
  setActiveParty: (party: WatchParty | null) => void;
  updatePlaybackState: (timeMs: number, isPlaying: boolean) => void;
  setQueue: (queue: MediaItem[]) => void;
  // ...
}
```

### Store: `mediaProviderStore.ts`
```typescript
interface MediaProviderState {
  connections: MediaProviderConnection[];
  fetchConnections: (serverId: number) => Promise<void>;
  linkProvider: (serverId: number, type: MediaProviderType, credentials: any) => Promise<void>;
  unlinkProvider: (connectionId: number) => Promise<void>;
}
```

### Components

**`MediaProviderSetupModal.tsx`**
- Provider type selector (Plex, YouTube, Spotify, etc.)
- Dynamic credential form based on selected provider
- Authentication flow (direct or OAuth)
- Connection test/validation

**`MediaLibraryBrowser.tsx`**
- Provider-agnostic browsing modal
- Search across all linked providers
- Provider tabs for multi-provider servers
- Grid view with thumbnails
- Click to add to queue or play immediately

**`WatchPartyPlayer.tsx`**
- Provider-agnostic player container
- Delegates to provider-specific player components:
  - `PlexPlayer.tsx` - HTML5 video
  - `YouTubePlayer.tsx` - YouTube iframe API
  - `SpotifyPlayer.tsx` - Spotify Web Playback SDK
- Playback controls (if host)
- Sync indicator showing drift
- Queue sidebar

**`WatchPartyControls.tsx`**
- Play/pause/seek controls (host only)
- Queue management with drag-to-reorder
- Provider-agnostic (works with any provider)
- Viewers see current state only

### Player Adapters (Provider-Specific)

Each provider needs a player adapter that implements a common interface:

```typescript
// playerAdapter.ts
export interface PlayerAdapter {
  initialize(container: HTMLElement, url: string): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(timeMs: number): Promise<void>;
  getCurrentTime(): number;
  isPaused(): boolean;
  destroy(): void;
}

// plexPlayerAdapter.ts
export class PlexPlayerAdapter implements PlayerAdapter {
  private video: HTMLVideoElement;

  async initialize(container: HTMLElement, url: string) {
    this.video = document.createElement('video');
    this.video.src = url;
    this.video.controls = false;
    container.appendChild(this.video);
  }

  async play() { await this.video.play(); }
  async pause() { this.video.pause(); }
  async seek(timeMs: number) { this.video.currentTime = timeMs / 1000; }
  getCurrentTime() { return this.video.currentTime * 1000; }
  isPaused() { return this.video.paused; }
  destroy() { this.video.remove(); }
}

// youtubePlayerAdapter.ts
export class YouTubePlayerAdapter implements PlayerAdapter {
  private player: YT.Player;

  async initialize(container: HTMLElement, videoId: string) {
    this.player = new YT.Player(container, {
      videoId,
      playerVars: { controls: 0, modestbranding: 1 }
    });
  }

  async play() { this.player.playVideo(); }
  async pause() { this.player.pauseVideo(); }
  async seek(timeMs: number) { this.player.seekTo(timeMs / 1000, true); }
  getCurrentTime() { return this.player.getCurrentTime() * 1000; }
  isPaused() { return this.player.getPlayerState() !== YT.PlayerState.PLAYING; }
  destroy() { this.player.destroy(); }
}

// spotifyPlayerAdapter.ts
export class SpotifyPlayerAdapter implements PlayerAdapter {
  private player: Spotify.Player;

  async initialize(container: HTMLElement, trackUri: string) {
    this.player = new Spotify.Player({ /* ... */ });
    await this.player.connect();
    await this.player._options.getOAuthToken((token) => {
      // Play track...
    });
  }

  // ... implement other methods
}
```

**`WatchPartyPlayer.tsx`** (Updated)
```typescript
const WatchPartyPlayer: React.FC = () => {
  const watchParty = useWatchPartyStore(s => s.activeParty);
  const containerRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<PlayerAdapter | null>(null);

  useEffect(() => {
    if (!watchParty || !containerRef.current) return;

    // Factory pattern for player adapters
    const createAdapter = async (): Promise<PlayerAdapter> => {
      switch (watchParty.providerType) {
        case 'Plex':
          const plexUrl = await fetchPlaybackUrl(watchParty.connectionId, watchParty.providerItemId);
          const plexAdapter = new PlexPlayerAdapter();
          await plexAdapter.initialize(containerRef.current!, plexUrl);
          return plexAdapter;

        case 'YouTube':
          const ytAdapter = new YouTubePlayerAdapter();
          await ytAdapter.initialize(containerRef.current!, watchParty.providerItemId);
          return ytAdapter;

        case 'Spotify':
          const spotifyAdapter = new SpotifyPlayerAdapter();
          await spotifyAdapter.initialize(containerRef.current!, watchParty.providerItemId);
          return spotifyAdapter;

        default:
          throw new Error(`Unsupported provider: ${watchParty.providerType}`);
      }
    };

    createAdapter().then(adapter => {
      adapterRef.current = adapter;
    });

    return () => {
      adapterRef.current?.destroy();
    };
  }, [watchParty?.providerType, watchParty?.providerItemId]);

  // Sync logic uses adapter methods instead of direct video element access
  // ... rest of sync logic
};
```

### Video Player Sync Logic (Provider-Agnostic)

```typescript
// In WatchPartyPlayer.tsx
const adapterRef = useRef<PlayerAdapter | null>(null);
const isHost = watchParty?.hostUserId === currentUserId;

// Host broadcasts position periodically
useEffect(() => {
  if (!isHost || !adapterRef.current) return;

  const interval = setInterval(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;

    signalR.send('ReportPlaybackPosition',
      channelId,
      adapter.getCurrentTime(),
      adapter.isPaused()
    );
  }, 2000);

  return () => clearInterval(interval);
}, [isHost]);

// Clients sync to broadcast position
useEffect(() => {
  if (isHost || !adapterRef.current || !watchParty) return;

  const adapter = adapterRef.current;
  const drift = Math.abs(adapter.getCurrentTime() - watchParty.currentTimeMs);

  if (drift > 1000) {  // More than 1s drift
    adapter.seek(watchParty.currentTimeMs);
  }

  if (watchParty.isPlaying && adapter.isPaused()) {
    adapter.play();
  } else if (!watchParty.isPlaying && !adapter.isPaused()) {
    adapter.pause();
  }
}, [watchParty?.currentTimeMs, watchParty?.isPlaying]);

// Handle user interactions (host only)
const handlePlayPause = async () => {
  if (!isHost || !adapterRef.current) return;

  const adapter = adapterRef.current;
  const isPaused = adapter.isPaused();

  if (isPaused) {
    await adapter.play();
  } else {
    await adapter.pause();
  }

  signalR.send('NotifyPlaybackCommand',
    channelId,
    isPaused ? 'play' : 'pause',
    adapter.getCurrentTime()
  );
};

const handleSeek = async (timeMs: number) => {
  if (!isHost || !adapterRef.current) return;

  await adapterRef.current.seek(timeMs);
  signalR.send('NotifyPlaybackCommand', channelId, 'seek', timeMs);
};
```

**Key Benefits:**
- Adding YouTube support requires **only** implementing `YouTubePlayerAdapter`
- No changes to sync logic, controls, or UI components
- Provider-specific quirks isolated to adapter classes

## Implementation Phases

### Phase 0: Foundation & Abstraction Layer
**Goal:** Build provider-agnostic foundation before any provider implementation

**Backend:**
- `MediaProviderType` enum
- `MediaProviderConnection` model + migration
- `IMediaProvider` interface
- `MediaProviderFactory` service
- Base controller: `MediaProvidersController`
- Provider-agnostic endpoints (link, search, playback)
- Data protection for encrypted config storage

**Frontend:**
- TypeScript types: `MediaProviderType`, `MediaProviderConnection`, `MediaItem`
- Stores: `mediaProviderStore`, `watchPartyStore`
- `PlayerAdapter` interface
- API client functions (provider-agnostic)

**Testing:**
- Verify factory pattern setup
- Test encrypted config storage
- Validate provider-agnostic API structure

**Deliverable:** Complete abstraction layer ready for provider implementations

---

### Phase 1: Plex Provider Implementation
**Goal:** Implement first concrete provider (Plex) using the abstraction layer

**Backend:**
- `PlexMediaProvider` class implementing `IMediaProvider`
- Plex API client service
- Register in `MediaProviderFactory`
- Plex-specific config: `{ serverUrl, authToken, machineId }`

**Frontend:**
- `PlexPlayerAdapter` implementing `PlayerAdapter`
- Plex credential form in `MediaProviderSetupModal`
- Register in player adapter factory

**Testing:**
- Link/unlink Plex server
- Verify token encryption
- Handle invalid credentials
- Validate Plex-specific config parsing

---

### Phase 2: Library Browsing & Search
**Goal:** Build provider-agnostic browsing UI

**Backend:**
- Implement library/search methods in `PlexMediaProvider`
- Add caching layer for metadata
- Thumbnail proxy endpoint (if needed)

**Frontend:**
- `MediaLibraryBrowser` component
- Provider tabs (future: multi-provider)
- Search/filter UI
- Thumbnail grid
- Add to queue / play now actions

**Testing:**
- Browse Plex libraries
- Search functionality
- Handle missing artwork
- Test with mock YouTube provider (stub)

---

### Phase 3: Watch Party State & Sync
**Goal:** Core watch party orchestration (provider-agnostic)

**Backend:**
- `WatchParty` model + migration
- `WatchPartyController` (start/stop/queue endpoints)
- SignalR events: `WatchPartyStarted`, `WatchPartyStopped`, `PlaybackCommand`, `SyncPosition`
- Hub methods: `NotifyPlaybackCommand`, `ReportPlaybackPosition`

**Frontend:**
- SignalR listeners in `MainLayout`
- `watchPartyStore` state management
- Basic sync logic (no player yet, just state)

**Testing:**
- Start/stop watch party
- State synchronization across clients
- SignalR message delivery
- Multiple viewers receive updates

---

### Phase 4: Player & Sync Implementation
**Goal:** Working synchronized player with Plex

**Backend:**
- Implement `GetPlaybackInfoAsync` in `PlexMediaProvider`
- Handle Plex transcoding preferences
- Per-user playback URL generation

**Frontend:**
- `WatchPartyPlayer` component with adapter pattern
- `PlexPlayerAdapter` with HTML5 video
- Host playback controls
- Viewer sync logic (drift detection/correction)
- Sync indicator UI

**Testing:**
- Direct play vs transcode
- Sync accuracy (<1s drift)
- Network interruption recovery
- Host/viewer role switching

---

### Phase 5: Queue System
**Goal:** Queue management for watch parties

**Backend:**
- Queue JSON storage in `WatchParty`
- Add/remove/reorder endpoints
- Auto-advance to next item logic
- `QueueUpdated` SignalR event

**Frontend:**
- Queue sidebar in player
- Drag-to-reorder (react-beautiful-dnd)
- Auto-play next item
- Queue persistence

**Testing:**
- Queue CRUD operations
- Queue sync across clients
- Auto-advance on item end
- Queue persistence across reconnects

---

### Phase 6: Permissions & Polish
**Goal:** Production-ready Plex integration

**Backend:**
- Permission checks (`Stream` permission required)
- Host transfer on disconnect
- Watch party cleanup on channel empty
- Rate limiting for provider APIs
- Error handling & logging

**Frontend:**
- Permission error messages
- Loading states & skeletons
- Mobile responsive player
- Error boundaries
- Reconnection handling

**Testing:**
- Permission enforcement
- Host disconnect scenarios
- Edge cases (network loss, tab close, etc.)
- Mobile browser compatibility

---

### Phase 7: YouTube Provider (Validation)
**Goal:** Prove abstraction layer works by adding second provider

**Backend:**
- `YouTubeMediaProvider` implementing `IMediaProvider`
- YouTube Data API v3 integration
- YouTube config: `{ apiKey }`
- Search implementation

**Frontend:**
- `YouTubePlayerAdapter` using YouTube iframe API
- YouTube credential form
- Provider switching in UI

**Testing:**
- Link YouTube API key
- Search YouTube videos
- Play YouTube video in watch party
- Verify no changes needed to core watch party logic

**Deliverable:** Confirms abstraction layer is production-ready

---

### Future Phases (Post-MVP)
- **Phase 8:** Spotify provider + Web Playback SDK
- **Phase 9:** Twitch provider + live stream support
- **Phase 10:** SoundCloud provider
- **Phase 11:** Multi-provider queue (mix Plex + YouTube in same queue)
- **Phase 12:** Provider-specific features (Plex intro skip, YouTube chapters, etc.)

## Dependencies

### Backend (Core)
- ASP.NET Data Protection API (token encryption) - built-in
- No new core dependencies for abstraction layer

### Backend (Provider-Specific)
- **Plex:** `Plex.ServerApi` NuGet package OR manual HTTP client
- **YouTube:** `Google.Apis.YouTube.v3` NuGet package
- **Spotify:** `SpotifyAPI.Web` NuGet package
- **Twitch:** Manual HTTP client (Helix API)

### Frontend (Core)
- Existing SignalR connection
- React, TypeScript, Zustand (already in project)

### Frontend (Provider-Specific)
- **Plex:** HTML5 `<video>` (built-in)
- **YouTube:** YouTube iframe API (loaded via script tag)
- **Spotify:** `spotify-web-playback-sdk` (npm package)
- **Twitch:** Twitch embed SDK (loaded via script tag)

## Adding New Providers (Developer Guide)

Adding a new media provider (e.g., Twitch, SoundCloud, Deezer) requires implementing just two classes and updating one registration point. **No changes to core watch party logic.**

### Step-by-Step Guide

#### 1. Add Provider to Enum
```csharp
// Backend: MediaProviderType.cs
public enum MediaProviderType
{
    // ...
    Twitch = 6  // Add new provider
}
```

```typescript
// Frontend: watchPartyTypes.ts
export type MediaProviderType = 'Plex' | 'YouTube' | 'Spotify' | 'Twitch';
```

#### 2. Implement Backend Provider
```csharp
// Backend: Services/MediaProviders/TwitchMediaProvider.cs
public class TwitchMediaProvider : IMediaProvider
{
    private readonly HttpClient _httpClient;
    private const string TWITCH_API = "https://api.twitch.tv/helix";

    public MediaProviderType ProviderType => MediaProviderType.Twitch;

    public TwitchMediaProvider(IHttpClientFactory httpClientFactory)
    {
        _httpClient = httpClientFactory.CreateClient();
    }

    public async Task<ProviderAuthResult> AuthenticateAsync(Dictionary<string, string> credentials)
    {
        // Validate Twitch client credentials
        var clientId = credentials["clientId"];
        var clientSecret = credentials["clientSecret"];

        // OAuth flow or validate credentials
        // ...

        return new ProviderAuthResult
        {
            Success = true,
            ConfigJson = JsonSerializer.Serialize(new { clientId, clientSecret }),
            DisplayName = "Twitch"
        };
    }

    public async Task<List<MediaItem>> SearchItemsAsync(string configJson, string query, string? libraryId)
    {
        var config = JsonSerializer.Deserialize<TwitchConfig>(configJson);

        // Use Twitch Helix API to search channels/videos
        var response = await _httpClient.GetAsync(
            $"{TWITCH_API}/search/channels?query={query}",
            // Add auth headers...
        );

        var channels = /* parse response */;

        return channels.Select(c => new MediaItem
        {
            Id = c.UserId,  // Stream by user ID
            Title = c.DisplayName,
            Subtitle = c.GameName,
            Thumbnail = c.ThumbnailUrl,
            DurationMs = null  // Live streams have no duration
        }).ToList();
    }

    public async Task<PlaybackInfo> GetPlaybackInfoAsync(string configJson, string itemId, long? userId)
    {
        // For Twitch, return embed URL or HLS stream
        return new PlaybackInfo
        {
            Url = $"https://player.twitch.tv/?channel={itemId}&parent=yourdomain.com",
            RequiresAuth = false,
            MimeType = "application/x-mpegURL"  // HLS
        };
    }

    // Implement remaining interface methods...
    public async Task<List<MediaLibrary>> GetLibrariesAsync(string configJson)
    {
        // Twitch doesn't have libraries, return empty or categories
        return new List<MediaLibrary>();
    }

    public string GetProviderDisplayName() => "Twitch";
    public List<string> GetRequiredCredentialFields() => new() { "clientId", "clientSecret" };
}
```

#### 3. Register in Factory
```csharp
// Backend: Services/MediaProviderFactory.cs
public MediaProviderFactory(IServiceProvider serviceProvider)
{
    _providers = new Dictionary<MediaProviderType, IMediaProvider>
    {
        { MediaProviderType.Plex, serviceProvider.GetRequiredService<PlexMediaProvider>() },
        { MediaProviderType.YouTube, serviceProvider.GetRequiredService<YouTubeMediaProvider>() },
        { MediaProviderType.Twitch, serviceProvider.GetRequiredService<TwitchMediaProvider>() },  // Add here
    };
}
```

```csharp
// Backend: Program.cs (DI registration)
builder.Services.AddScoped<TwitchMediaProvider>();
```

#### 4. Implement Frontend Player Adapter
```typescript
// Frontend: src/services/playerAdapters/twitchPlayerAdapter.ts
export class TwitchPlayerAdapter implements PlayerAdapter {
  private player: any;  // Twitch embed player
  private iframe: HTMLIFrameElement;

  async initialize(container: HTMLElement, channelName: string): Promise<void> {
    // Load Twitch embed script if needed
    await this.loadTwitchEmbedScript();

    this.iframe = document.createElement('iframe');
    this.iframe.src = `https://player.twitch.tv/?channel=${channelName}&parent=${window.location.hostname}`;
    this.iframe.allowFullscreen = true;
    container.appendChild(this.iframe);

    // Note: Twitch embeds have limited JS API, may need postMessage communication
    // or fall back to basic controls
  }

  async play(): Promise<void> {
    // Twitch live streams auto-play, no-op or use postMessage API
  }

  async pause(): Promise<void> {
    // Live streams can't pause, handle gracefully
    console.warn('Cannot pause live Twitch stream');
  }

  async seek(timeMs: number): Promise<void> {
    // VODs can seek, live streams can't
    console.warn('Cannot seek live Twitch stream');
  }

  getCurrentTime(): number {
    // For live streams, return 0 or current buffer position
    return 0;
  }

  isPaused(): boolean {
    return false;  // Live streams are always "playing"
  }

  destroy(): void {
    this.iframe.remove();
  }

  private async loadTwitchEmbedScript(): Promise<void> {
    // Load Twitch embed.js if not already loaded
  }
}
```

#### 5. Register Player Adapter
```typescript
// Frontend: src/components/WatchPartyPlayer.tsx
const createAdapter = async (): Promise<PlayerAdapter> => {
  switch (watchParty.providerType) {
    case 'Plex':
      return new PlexPlayerAdapter();
    case 'YouTube':
      return new YouTubePlayerAdapter();
    case 'Twitch':  // Add here
      return new TwitchPlayerAdapter();
    default:
      throw new Error(`Unsupported provider: ${watchParty.providerType}`);
  }
};
```

#### 6. Add Credential Form (Optional UI Polish)
```typescript
// Frontend: src/components/MediaProviderSetupModal.tsx
const renderCredentialFields = () => {
  switch (selectedProvider) {
    case 'Plex':
      return <><Input name="username" /><Input name="password" type="password" /></>;
    case 'YouTube':
      return <Input name="apiKey" />;
    case 'Twitch':  // Add here
      return <><Input name="clientId" /><Input name="clientSecret" type="password" /></>;
    // ...
  }
};
```

### That's It!

**Total files modified:** 5-6 files
**Lines of code:** ~200-300 (mostly provider-specific logic)
**Core watch party changes:** 0

The abstraction layer handles:
- ✅ Authentication & storage
- ✅ State synchronization
- ✅ Queue management
- ✅ Playback controls
- ✅ SignalR events
- ✅ Permissions
- ✅ UI scaffolding

You only implement:
- Provider API integration
- Player adapter for that provider's media format

---

## Security Considerations

1. **Token Storage:** Encrypt Plex auth tokens using ASP.NET Data Protection API
2. **Access Control:**
   - Only server owner can link Plex server
   - Require `Stream` permission to start watch party
   - Validate user has Plex server access before returning playback URL
3. **Rate Limiting:** Limit Plex API calls to prevent abuse
4. **Input Validation:** Sanitize all Plex item keys/metadata before storage

## Open Questions

1. **Provider Access Control:**
   - **Plex:** How to verify users have access to the linked Plex server? Require owner to grant access via Plex Home/managed users?
   - **YouTube:** Public videos only, or support private/unlisted with individual auth?
   - **Spotify:** Require all users to have Spotify Premium (SDK requirement)?
   - **General:** Should users authenticate individually with each provider, or trust server owner's connection?

2. **Multiple Providers:**
   - Support multiple connections per provider? (e.g., two different Plex servers)
   - Limit to one connection per provider per server for simplicity?
   - Current design supports multiple connections (each has unique ID)

3. **Provider-Specific Settings:**
   - **Plex:** Expose transcoding quality settings in UI?
   - **YouTube:** Respect age restrictions / content warnings?
   - **Spotify:** Allow explicit content toggle?
   - Store provider-specific settings in `MediaProviderConnection.ProviderConfigJson`?

4. **Mobile Support:**
   - HTML5 video works on mobile web for Plex/direct URLs
   - YouTube/Spotify SDKs have mobile browser limitations
   - Native mobile apps (Expo) would need platform-specific player adapters

5. **Host Transfer:**
   - What happens if host disconnects mid-watch party?
   - Options:
     - Auto-promote next user in voice channel
     - Pause watch party until host returns
     - Stop watch party entirely
   - Should host role be transferable manually?

6. **Mixed-Provider Queues:**
   - Should queue support mixing providers? (Plex video → YouTube video → Spotify song)
   - Current design supports this (queue items have `providerItemId` + implied `providerType` from connection)
   - But: Need to handle player transitions between providers

7. **Live Streams:**
   - Twitch/YouTube live streams have no seekable timeline
   - How to handle sync? (all join at current live position?)
   - Should live streams disable seek/pause controls?

8. **Rate Limiting:**
   - How aggressively to rate-limit provider API calls?
   - Cache metadata/thumbnails to reduce API usage?
   - Per-provider rate limit configurations?

## Legal/Compliance Notes

### General Principles
- **Abyss does NOT host, store, or redistribute media content**
- Feature facilitates synchronized playback only (like Teleparty, Syncplay, Discord YouTube)
- All media streams directly from provider to end-user
- Server owners responsible for ensuring legal access to content

### Provider-Specific Considerations

**Plex:**
- ✅ Users streaming their own legally obtained media (personal libraries)
- ⚠️ Server owner must have rights to content being shared
- ⚠️ Users should have explicit permission to access the Plex server (Plex Home/managed users)
- Recommendation: Clearly document that this is for personal libraries only

**YouTube:**
- ✅ Public YouTube videos are fine (similar to Discord's YouTube watch together)
- ⚠️ Embedding YouTube videos requires compliance with YouTube Terms of Service
- ⚠️ Cannot use youtube-dl or similar tools to extract direct streams (violates ToS)
- Must use official YouTube iframe API or embed URLs
- Recommendation: Only support public videos, respect age restrictions

**Spotify:**
- ✅ Using official Spotify Web Playback SDK (compliant with ToS)
- ⚠️ All users must have Spotify Premium (SDK requirement)
- ⚠️ Cannot download or cache Spotify streams
- Must display Spotify branding and controls as per SDK guidelines

**Twitch:**
- ✅ Embedding Twitch streams is allowed (official embed API)
- Must use official Twitch embed player
- Must include Twitch branding

### Recommendations

1. **Terms of Service Update:**
   - Add clause: "Users must only share legally obtained content with proper licensing"
   - Prohibit pirated content explicitly
   - Mention that server owners are responsible for compliance

2. **UI Disclaimers:**
   - When linking providers: "Ensure you have rights to share this content"
   - When starting watch party: "Only share content you have permission to broadcast"

3. **DMCA Compliance:**
   - Since Abyss doesn't host content, DMCA notices would go to provider (Plex server owner, YouTube, etc.)
   - Still good practice to have DMCA policy for user-generated content on platform

4. **Privacy:**
   - Provider credentials encrypted at rest
   - Don't log media URLs or user watch history beyond sync state

### Legal Risk Assessment

| Provider | Risk Level | Notes |
|----------|-----------|-------|
| Plex | Low | Personal media libraries, similar to screen sharing |
| YouTube | Low | Public embeds explicitly allowed by YouTube |
| Spotify | Low | Official SDK, requires Premium for all users |
| Twitch | Low | Official embed, live streams are meant to be shared |

**Overall:** Feature is legally similar to Discord's watch together or Teleparty. Primary risk is users sharing pirated content via Plex, mitigated by clear ToS.
