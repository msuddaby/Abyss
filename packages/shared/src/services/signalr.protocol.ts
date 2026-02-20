// Shared types for the SignalR Web Worker message protocol.
// Both the worker and the main-thread proxy import from here.

// ── Events the worker pre-registers on the HubConnection ─────────────────────
// Collected from useSignalRListeners + useWebRTC — every event name that
// consumer code calls conn.on() for.
export const ALL_SIGNALR_EVENTS = [
  // Presence
  'UserOnline', 'UserOffline', 'UserPresenceStatusChanged', 'UserIsTyping',
  // Voice sidebar
  'VoiceUserJoinedChannel', 'VoiceUserLeftChannel', 'VoiceUserStateUpdated',
  'ScreenShareStartedInChannel', 'ScreenShareStoppedInChannel',
  'CameraStartedInChannel', 'CameraStoppedInChannel',
  // Members / profiles
  'UserProfileUpdated', 'MemberJoined', 'MemberRolesUpdated', 'MemberKicked',
  'MemberBanned', 'MemberUnbanned', 'UserCosmeticsChanged',
  // Roles
  'RoleCreated', 'RoleUpdated', 'RoleDeleted',
  // Emojis
  'EmojiCreated', 'EmojiUpdated', 'EmojiDeleted',
  // Channels
  'ChannelCreated', 'ChannelUpdated', 'ChannelDeleted', 'ChannelsReordered',
  'ChannelPermissionsUpdated',
  // Servers
  'ServerDeleted', 'ServerUpdated',
  // Messages
  'ReceiveMessage', 'MessageEdited', 'MessageDeleted',
  'ReactionAdded', 'ReactionRemoved',
  // Unreads / notifications
  'NewUnreadMessage', 'MentionReceived',
  // DMs
  'DmChannelCreated',
  // Friends
  'FriendRequestReceived', 'FriendRequestAccepted', 'FriendRemoved',
  // System
  'Error', 'RateLimited', 'ConfigUpdated',
  // Notification settings
  'ServerDefaultNotificationLevelChanged', 'NotificationSettingsChanged',
  'UserPreferencesChanged',
  // Watch party
  'WatchPartyStarted', 'WatchPartyStopped', 'WatchPartyActive',
  'PlaybackCommand', 'SyncPosition', 'QueueUpdated', 'WatchPartyHostChanged',
  'WatchPartyStartedInChannel', 'WatchPartyStoppedInChannel',
  // Media providers
  'MediaProviderLinked', 'MediaProviderUnlinked',
  // Soundboard
  'SoundboardClipPlayed', 'SoundboardClipAdded', 'SoundboardClipUpdated',
  'SoundboardClipRemoved',
  // WebRTC voice (useWebRTC)
  'UserJoinedVoice', 'UserLeftVoice', 'ChannelRelayActive',
  'ReceiveSignal', 'VoiceChannelUsers',
  'ScreenShareStarted', 'ScreenShareStopped', 'ActiveSharers',
  'CameraStarted', 'CameraStopped', 'ActiveCameras',
  'WatchStreamRequested', 'StopWatchingRequested', 'VoiceSessionReplaced',
] as const;

export type SignalREventName = (typeof ALL_SIGNALR_EVENTS)[number];

// ── Main → Worker messages ───────────────────────────────────────────────────

export type MainToWorkerMessage =
  | { type: 'init'; url: string; hubPath: string }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'suspend' }
  | { type: 'reset' }
  | { type: 'invoke'; id: number; method: string; args: unknown[] }
  | { type: 'token-response'; id: number; token: string }
  | { type: 'visibility-change'; hidden: boolean }
  | { type: 'focus-reconnect'; id: number; restartOnFailure: boolean }
  | { type: 'ensure-connected'; id: number };

// ── Worker → Main messages ───────────────────────────────────────────────────

export type WorkerToMainMessage =
  | { type: 'event'; name: string; args: unknown[] }
  | { type: 'invoke-result'; id: number; ok: true; result: unknown }
  | { type: 'invoke-result'; id: number; ok: false; error: string }
  | { type: 'state-change'; state: string }
  | { type: 'reconnecting'; error: string | null }
  | { type: 'reconnected' }
  | { type: 'closed'; error: string | null; intentional: boolean }
  | { type: 'token-request'; id: number }
  | { type: 'log'; level: 'log' | 'warn' | 'debug'; message: string }
  | { type: 'started' }
  | { type: 'start-error'; error: string }
  | { type: 'stopped' }
  | { type: 'focus-reconnect-result'; id: number; alive: boolean }
  | { type: 'ensure-connected-result'; id: number; ok: true }
  | { type: 'ensure-connected-result'; id: number; ok: false; error: string };

// ── SignalRConnection interface (used by consumers instead of HubConnection) ─

export interface SignalRConnection {
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler?: (...args: any[]) => void): void;
  invoke(method: string, ...args: unknown[]): Promise<any>;
  readonly state: string;
}
