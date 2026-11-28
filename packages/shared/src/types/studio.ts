// Studio (collaborative DAW) types. The doc shape mirrors the server's
// StudioSessionService schema — keep the two in sync.

/** 'return' tracks are fed by sends; 'group' tracks sum the tracks routed into them. Neither holds clips. */
export type StudioTrackKind = 'audio' | 'instrument' | 'return' | 'group';
export type StudioClipKind = 'audio' | 'midi';
export type StudioInstrumentType = 'synth' | 'fm' | 'am' | 'mono' | 'pluck' | 'drums' | 'bass' | 'sampler' | 'soundfont';
export type StudioEffectType = 'reverb' | 'delay' | 'eq' | 'compressor' | 'distortion' | 'chorus' | 'filter' | 'tape' | 'limiter';
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
  /** Project key: root pitch class (0 = C) */
  scaleRoot?: number;
  /** Project scale id (see client studio/scales.ts); 'none' or absent = no scale */
  scaleMode?: string;
  /** Master bus devices (after every track, before the output) */
  masterEffects?: StudioEffect[];
  /** Master fader, dB */
  masterVolume?: number;
}

/** A named point on the timeline (Verse, Chorus…). */
export interface StudioMarker {
  /** Beats */
  beat: number;
  name: string;
  color?: string;
}

/**
 * A tempo and/or time-signature change from `beat` onwards. The project's
 * starting values live in meta; signature changes must sit on a bar line.
 */
export interface StudioTempoEvent {
  /** Beats (> 0) */
  beat: number;
  bpm?: number;
  num?: number;
  den?: number;
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
  /**
   * Automation lanes: laneKey → [beat, value] breakpoints (sorted, linear).
   * Keys: 'vol', 'pan', 'fx:{effectId}:{param}', 'inst:{param}'.
   */
  automation?: Record<string, [number, number][]>;
  /** Group track this one feeds; absent/'' = master */
  output?: string;
  /** Post-fader send levels: return track id → dB */
  sends?: Record<string, number>;
  /** Group tracks: children hidden in the arrangement */
  collapsed?: boolean;
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
  /** Inactive (e.g. an unused take) — kept but silent */
  mute?: boolean;
  /** Audio: stretch to the project tempo (srcBpm = the recording's tempo) */
  warp?: boolean;
  srcBpm?: number;
  /** Audio: transpose in semitones (keeps length when warped, otherwise repitches) */
  pitch?: number;
  /** Audio: play the source backwards */
  reverse?: boolean;
  // MIDI clips
  notes?: Record<string, StudioNote>;
}

export interface StudioDoc {
  meta: StudioMeta;
  tracks: Record<string, StudioTrack>;
  clips: Record<string, StudioClip>;
  /** Absent in projects saved before markers existed */
  markers?: Record<string, StudioMarker>;
  tempo?: Record<string, StudioTempoEvent>;
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
  /** When editingClipId was opened (server clock ms) — the earliest opener holds the soft lock */
  editingSince?: number | null;
  /** Left edge of the arrangement view in beats (for "follow") */
  viewBeats?: number | null;
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

/** One entry in a studio's edit history (an accepted batch, or a whole-project restore). */
export interface StudioChangeEntry {
  id: number;
  version: number;
  userId: string;
  createdAt: string;
  kind: 'edit' | 'restore';
  summary: string;
  opCount: number;
}

/** A saved snapshot of a studio project. */
export interface StudioVersionInfo {
  id: string;
  name: string;
  auto: boolean;
  createdById: string | null;
  createdAt: string;
  docVersion: number;
}
