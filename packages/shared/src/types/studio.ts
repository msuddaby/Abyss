// Studio (collaborative DAW) types. The doc shape mirrors the server's
// StudioSessionService schema — keep the two in sync.

export type StudioTrackKind = 'audio' | 'instrument';
export type StudioClipKind = 'audio' | 'midi';
export type StudioInstrumentType = 'synth' | 'fm' | 'am' | 'mono' | 'pluck' | 'drums' | 'bass';
export type StudioEffectType = 'reverb' | 'delay' | 'eq' | 'compressor' | 'distortion' | 'chorus';
export type StudioParams = Record<string, number | string | boolean>;

export interface StudioMeta {
  bpm: number;
  timeSigNum: number;
  timeSigDen: number;
  loopEnabled: boolean;
  /** Beats */
  loopStart: number;
  /** Beats */
  loopEnd: number;
}

export interface StudioEffect {
  id: string;
  type: StudioEffectType;
  bypass?: boolean;
  params?: StudioParams;
}

export interface StudioInstrument {
  type: StudioInstrumentType;
  params?: StudioParams;
}

export interface StudioTrack {
  name: string;
  kind: StudioTrackKind;
  order: number;
  color?: string;
  /** dB, -60..12 */
  volume: number;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  instrument?: StudioInstrument;
  effects?: StudioEffect[];
}

export interface StudioNote {
  /** MIDI note number 0..127 */
  pitch: number;
  /** Beats, relative to clip start */
  start: number;
  /** Beats */
  len: number;
  /** 0..1 */
  vel: number;
}

export interface StudioClip {
  trackId: string;
  kind: StudioClipKind;
  /** Beats on the timeline */
  start: number;
  /** Beats */
  length: number;
  name?: string;
  /** dB */
  gain: number;
  color?: string;
  // Audio clips — offset/fades are seconds of source audio (native rate, no warping)
  assetId?: string;
  offset?: number;
  fadeIn?: number;
  fadeOut?: number;
  // MIDI clips
  notes?: Record<string, StudioNote>;
}

export interface StudioDoc {
  meta: StudioMeta;
  tracks: Record<string, StudioTrack>;
  clips: Record<string, StudioClip>;
}

export type StudioOp =
  | { t: 'set'; path: string[]; value: unknown }
  | { t: 'del'; path: string[] };

export interface StudioOpsBroadcast {
  channelId: string;
  version: number;
  userId: string;
  clientBatchId: string;
  ops: StudioOp[];
}

export interface StudioAsset {
  id: string;
  name: string;
  url: string;
  durationSec: number;
  fileSize: number;
  uploadedById: string;
  createdAt: string;
}

/** Ephemeral per-user state relayed to collaborators (never persisted). */
export interface StudioPresence {
  /** Selected clip ids */
  selection?: string[];
  /** Live drag preview of a clip being moved/trimmed */
  drag?: { clipId: string; trackId: string; start: number; length: number } | null;
  /** Local playhead in beats, when playing */
  playheadBeats?: number | null;
  /** Clip open in the piano roll */
  editingClipId?: string | null;
}

export interface StudioTransport {
  isPlaying: boolean;
  positionBeats: number;
  /** Server clock when the state was set */
  serverTimeMs: number;
  userId: string | null;
}

export interface StudioJoinResult {
  doc: StudioDoc;
  version: number;
  transport: StudioTransport;
  presence: Record<string, StudioPresence>;
  users: string[];
  canEdit: boolean;
  serverTimeMs: number;
}
