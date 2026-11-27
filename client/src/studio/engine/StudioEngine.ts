import * as Tone from 'tone';
import { beatsToSeconds } from '@abyss/shared';
import type { StudioDoc, StudioTrack, StudioClip } from '@abyss/shared';
import { createInstrument, createEffect, type PlayableInstrument } from './instruments';
import { getBuffer } from './assetCache';

// Renders a StudioDoc with Tone.js. `sync(doc)` diffs the doc against the
// current audio graph by entity id and rebuilds only what changed, so remote
// edits are cheap. Time in the doc is in beats (quarter notes); clips are
// rescheduled when the tempo changes.
//
// Graph per track:  sources → input(Gain) → [effects…] → Channel(vol/pan/mute/solo) → master
//
// Constructed against the *current* Tone context, so building one inside
// Tone.Offline() gives an export renderer with identical sound.

interface TrackNode {
  input: Tone.Gain;
  channel: Tone.Channel;
  meter: Tone.Meter | null;
  effects: Tone.ToneAudioNode[];
  fxKey: string;
  instrument: PlayableInstrument | null;
  instKey: string;
  /** bumps on every effect rebuild so stale async builds are discarded */
  fxGen: number;
  fxReady: Promise<void>;
}

interface ClipNode {
  key: string;
  player?: Tone.Player;
  part?: Tone.Part;
}

function audioClipKey(c: StudioClip, bpm: number, hasBuffer: boolean): string {
  return `${c.trackId}|${c.start}|${c.length}|${c.assetId}|${c.offset}|${c.gain}|${c.fadeIn}|${c.fadeOut}|${bpm}|${hasBuffer}`;
}

function midiClipKey(c: StudioClip, instKey: string): string {
  // Notes object identity changes on any note edit (copy-on-write), but
  // stringify keeps remote no-op updates from rebuilding.
  return `${c.trackId}|${c.start}|${c.length}|${c.gain}|${instKey}|${JSON.stringify(c.notes ?? {})}`;
}

export class StudioEngine {
  readonly transport: ReturnType<typeof Tone.getTransport>;
  private readonly master: Tone.Channel;
  private readonly masterMeter: Tone.Meter | null;
  private readonly tracks = new Map<string, TrackNode>();
  private readonly clips = new Map<string, ClipNode>();
  private readonly withMeters: boolean;
  private doc: StudioDoc | null = null;
  private metronome: Tone.Loop | null = null;
  private click: Tone.Synth | null = null;
  private metronomeOn = false;
  private disposed = false;

  constructor(opts: { meters?: boolean } = {}) {
    this.withMeters = opts.meters ?? true;
    this.transport = Tone.getTransport();
    this.master = new Tone.Channel({ volume: 0 }).toDestination();
    this.masterMeter = this.withMeters ? new Tone.Meter({ smoothing: 0.85 }) : null;
    if (this.masterMeter) this.master.connect(this.masterMeter);
  }

  // ───────────────────────── Doc sync ─────────────────────────

  sync(doc: StudioDoc) {
    if (this.disposed) return;
    this.doc = doc;
    const { meta } = doc;
    const ppq = this.transport.PPQ;

    if (this.transport.bpm.value !== meta.bpm) this.transport.bpm.value = meta.bpm;
    this.transport.timeSignature = [meta.timeSigNum, meta.timeSigDen];
    const loopOk = meta.loopEnabled && meta.loopEnd > meta.loopStart;
    this.transport.loop = loopOk;
    if (loopOk) {
      this.transport.loopStart = `${Math.round(meta.loopStart * ppq)}i`;
      this.transport.loopEnd = `${Math.round(meta.loopEnd * ppq)}i`;
    }

    // Tracks
    for (const [id, track] of Object.entries(doc.tracks)) this.syncTrack(id, track, meta.bpm);
    for (const id of [...this.tracks.keys()]) {
      if (!doc.tracks[id]) this.disposeTrack(id);
    }

    // Clips
    for (const [id, clip] of Object.entries(doc.clips)) {
      if (!this.tracks.has(clip.trackId)) continue;
      if (clip.kind === 'audio') this.syncAudioClip(id, clip, meta.bpm);
      else this.syncMidiClip(id, clip);
    }
    for (const id of [...this.clips.keys()]) {
      const clip = doc.clips[id];
      if (!clip || !this.tracks.has(clip.trackId)) this.disposeClip(id);
    }
  }

  /** Re-sync after an asset finishes loading (its clips can now get players). */
  refresh() {
    if (this.doc) this.sync(this.doc);
  }

  private syncTrack(id: string, track: StudioTrack, bpm: number) {
    let node = this.tracks.get(id);
    if (!node) {
      const input = new Tone.Gain(1);
      const channel = new Tone.Channel({ volume: track.volume, pan: track.pan, mute: track.mute, solo: track.solo });
      channel.connect(this.master);
      const meter = this.withMeters ? new Tone.Meter({ smoothing: 0.8 }) : null;
      if (meter) channel.connect(meter);
      input.connect(channel);
      node = { input, channel, meter, effects: [], fxKey: '[]', instrument: null, instKey: '', fxGen: 0, fxReady: Promise.resolve() };
      this.tracks.set(id, node);
    }

    const ch = node.channel;
    if (ch.volume.value !== track.volume) ch.volume.rampTo(track.volume, 0.02);
    if (ch.pan.value !== track.pan) ch.pan.rampTo(track.pan, 0.02);
    if (ch.mute !== track.mute) ch.mute = track.mute;
    if (ch.solo !== track.solo) ch.solo = track.solo;

    // Instrument
    const instKey = track.kind === 'instrument' ? JSON.stringify(track.instrument ?? { type: 'synth' }) : '';
    if (instKey !== node.instKey) {
      node.instrument?.releaseAll();
      node.instrument?.dispose();
      node.instrument = null;
      node.instKey = instKey;
      if (track.kind === 'instrument') {
        node.instrument = createInstrument(track.instrument);
        node.instrument.output.connect(node.input);
      }
      // MIDI parts hold a reference to the old instrument via the closure key.
      for (const [clipId, clip] of Object.entries(this.doc?.clips ?? {})) {
        if (clip.trackId === id && clip.kind === 'midi') this.disposeClip(clipId);
      }
    }

    // Effects (delay time depends on tempo)
    const fxKey = JSON.stringify(track.effects ?? []) + (track.effects?.some((f) => f.type === 'delay') ? `@${bpm}` : '');
    if (fxKey !== node.fxKey) {
      node.fxKey = fxKey;
      node.fxReady = this.rebuildEffects(node, track, bpm);
    }
  }

  private async rebuildEffects(node: TrackNode, track: StudioTrack, bpm: number) {
    const gen = ++node.fxGen;
    const active = (track.effects ?? []).filter((f) => !f.bypass);
    const built = await Promise.all(active.map((fx) => createEffect(fx, bpm)));
    if (gen !== node.fxGen || this.disposed) {
      for (const fx of built) fx.dispose();
      return;
    }
    node.input.disconnect();
    for (const fx of node.effects) fx.dispose();
    node.effects = built;
    const chain: Tone.ToneAudioNode[] = [node.input, ...built, node.channel];
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  }

  private syncAudioClip(id: string, clip: StudioClip, bpm: number) {
    const buffer = clip.assetId ? getBuffer(clip.assetId) : undefined;
    const key = audioClipKey(clip, bpm, !!buffer);
    const existing = this.clips.get(id);
    if (existing?.key === key) return;
    this.disposeClip(id);
    if (!buffer) {
      this.clips.set(id, { key });
      return;
    }

    const offset = Math.max(0, clip.offset ?? 0);
    const duration = Math.min(beatsToSeconds(clip.length, bpm), buffer.duration - offset);
    if (duration <= 0) {
      this.clips.set(id, { key });
      return;
    }
    const player = new Tone.Player(buffer);
    player.volume.value = clip.gain ?? 0;
    player.fadeIn = Math.min(clip.fadeIn ?? 0, duration / 2);
    player.fadeOut = Math.min(clip.fadeOut ?? 0, duration / 2);
    player.connect(this.tracks.get(clip.trackId)!.input);
    player.sync().start(beatsToSeconds(clip.start, bpm), offset, duration);
    this.clips.set(id, { key, player });
  }

  private syncMidiClip(id: string, clip: StudioClip) {
    const track = this.tracks.get(clip.trackId);
    if (!track?.instrument) return;
    const key = midiClipKey(clip, track.instKey);
    if (this.clips.get(id)?.key === key) return;
    this.disposeClip(id);

    const ppq = this.transport.PPQ;
    const instrument = track.instrument;
    const gain = Tone.dbToGain(clip.gain ?? 0);
    const events = Object.values(clip.notes ?? {})
      .filter((n) => n.start < clip.length)
      .map((n) => ({
        time: `${Math.round(n.start * ppq)}i`,
        pitch: n.pitch,
        // Notes are cut at the clip boundary
        lenTicks: Math.round(Math.min(n.len, clip.length - n.start) * ppq),
        vel: Math.min(1, n.vel * gain),
      }));
    const part = new Tone.Part((time, ev) => {
      const dur = Tone.Ticks(ev.lenTicks).toSeconds();
      instrument.play(ev.pitch, dur, time, ev.vel);
    }, events);
    part.start(`${Math.round(clip.start * ppq)}i`);
    // Stop the part at the clip end so stray events can't fire.
    part.stop(`${Math.round((clip.start + clip.length) * ppq)}i`);
    this.clips.set(id, { key, part });
  }

  private disposeClip(id: string) {
    const node = this.clips.get(id);
    if (!node) return;
    if (node.player) {
      node.player.unsync();
      node.player.dispose();
    }
    node.part?.dispose();
    this.clips.delete(id);
  }

  private disposeTrack(id: string) {
    const node = this.tracks.get(id);
    if (!node) return;
    for (const [clipId] of this.clips) {
      if (this.doc?.clips[clipId]?.trackId === id || !this.doc?.clips[clipId]) this.disposeClip(clipId);
    }
    node.fxGen++;
    node.instrument?.dispose();
    for (const fx of node.effects) fx.dispose();
    node.meter?.dispose();
    node.input.dispose();
    node.channel.dispose();
    this.tracks.delete(id);
  }

  /** Resolves when every track's effect chain is built (needed before offline render). */
  async ready() {
    await Promise.all([...this.tracks.values()].map((t) => t.fxReady));
  }

  // ───────────────────────── Transport ─────────────────────────

  get bpm() {
    return this.doc?.meta.bpm ?? this.transport.bpm.value;
  }

  get isPlaying() {
    return this.transport.state === 'started';
  }

  getPositionBeats(): number {
    return this.transport.ticks / this.transport.PPQ;
  }

  async play(fromBeats: number) {
    await Tone.start();
    if (this.disposed) return;
    const ticks = Math.max(0, Math.round(fromBeats * this.transport.PPQ));
    if (this.isPlaying) {
      this.transport.ticks = ticks;
      return;
    }
    this.transport.ticks = ticks;
    // Small lookahead so the first events aren't dropped.
    this.transport.start('+0.05');
  }

  stop() {
    if (this.transport.state !== 'stopped') this.transport.pause();
    for (const t of this.tracks.values()) t.instrument?.releaseAll();
  }

  seek(beats: number) {
    this.transport.ticks = Math.max(0, Math.round(beats * this.transport.PPQ));
  }

  setMetronome(on: boolean) {
    this.metronomeOn = on;
    if (on && !this.metronome) {
      this.click = new Tone.Synth({ oscillator: { type: 'square' }, envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 } });
      this.click.volume.value = -10;
      this.click.toDestination();
      this.metronome = new Tone.Loop((time) => {
        const ppq = this.transport.PPQ;
        const meta = this.doc?.meta;
        const barBeats = meta ? (meta.timeSigNum * 4) / meta.timeSigDen : 4;
        const beat = Math.round(this.transport.getTicksAtTime(time) / ppq);
        const downbeat = Math.abs(beat % barBeats) < 1e-6;
        this.click?.triggerAttackRelease(downbeat ? 'C6' : 'G5', 0.03, time);
      }, '4n').start(0);
    } else if (!on && this.metronome) {
      this.metronome.dispose();
      this.click?.dispose();
      this.metronome = null;
      this.click = null;
    }
  }

  get metronomeEnabled() {
    return this.metronomeOn;
  }

  /** Audition a note on an instrument track (piano roll, keyboard). */
  async previewNote(trackId: string, pitch: number, velocity = 0.8) {
    await Tone.start();
    this.tracks.get(trackId)?.instrument?.play(pitch, 0.3, Tone.now(), velocity);
  }

  /** Current level per track in dB (−Infinity when silent). */
  getLevels(): { master: number; tracks: Record<string, number> } {
    const tracks: Record<string, number> = {};
    for (const [id, t] of this.tracks) {
      const v = t.meter?.getValue();
      tracks[id] = typeof v === 'number' ? v : -Infinity;
    }
    const m = this.masterMeter?.getValue();
    return { master: typeof m === 'number' ? m : -Infinity, tracks };
  }

  /** Live slider feedback before the value is committed to the doc. */
  previewTrackVolume(trackId: string, db: number) {
    this.tracks.get(trackId)?.channel.volume.rampTo(db, 0.02);
  }

  previewTrackPan(trackId: string, pan: number) {
    this.tracks.get(trackId)?.channel.pan.rampTo(pan, 0.02);
  }

  setMasterVolume(db: number) {
    this.master.volume.rampTo(db, 0.02);
  }

  dispose() {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    for (const id of [...this.clips.keys()]) this.disposeClip(id);
    for (const id of [...this.tracks.keys()]) this.disposeTrack(id);
    this.metronome?.dispose();
    this.click?.dispose();
    this.masterMeter?.dispose();
    this.master.dispose();
    this.transport.cancel(0);
  }
}
