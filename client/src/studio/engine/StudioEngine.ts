import * as Tone from 'tone';
import { beatsToSeconds } from '@abyss/shared';
import type { StudioDoc, StudioTrack, StudioClip, StudioParams } from '@abyss/shared';
import { createInstrument, samplerAssetId, LIVE_UPDATE_TYPES, type PlayableInstrument } from './instruments';
import { ensureSynthWorklet, isSynthReady } from './wavetable/synthNode';
import { EFFECT_DEFS, resolveParams, buildDevice, type FxDevice, type Resolved } from './effects';
import { getBuffer } from './assetCache';
import { valueAt } from './automationMath';

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
  /** Live effect devices by effect id (bypassed ones stay alive, unwired) */
  devices: Map<string, { device: FxDevice; type: string; paramKey: string; params: Resolved }>;
  /** Current wiring, so a rewire disconnects exactly what it connected */
  wiring: [Tone.ToneAudioNode, Tone.ToneAudioNode][];
  chainKey: string;
  instrument: PlayableInstrument | null;
  instKey: string;
  instParamsKey: string;
  autoKey: string;
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
  // A plain Volume, not a Channel: Tone's solo silences every non-soloed
  // Channel, which would include the master bus.
  private readonly master: Tone.Volume;
  private readonly masterMeter: Tone.Meter | null;
  private readonly tracks = new Map<string, TrackNode>();
  private readonly clips = new Map<string, ClipNode>();
  private readonly withMeters: boolean;
  private doc: StudioDoc | null = null;
  private metronome: Tone.Loop | null = null;
  private click: Tone.Synth | null = null;
  private metronomeOn = false;
  private disposed = false;
  private autoEvent = -1;

  constructor(opts: { meters?: boolean } = {}) {
    this.withMeters = opts.meters ?? true;
    this.transport = Tone.getTransport();
    this.master = new Tone.Volume(0).toDestination();
    this.masterMeter = this.withMeters ? new Tone.Meter({ smoothing: 0.85 }) : null;
    if (this.masterMeter) this.master.connect(this.masterMeter);
    // Automation runs on the transport clock (works offline for export too).
    this.autoEvent = this.transport.scheduleRepeat((time) => this.applyAutomation(time), '64n', 0);
    // Wavetable synth tracks are silent until the worklet loads, then rebuilt.
    if (!isSynthReady()) {
      ensureSynthWorklet()
        .then(() => { if (!this.disposed) this.refresh(); })
        .catch((e) => console.warn('[studio] wavetable synth unavailable', e));
    }
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
      node = { input, channel, meter, devices: new Map(), wiring: [[input, channel]], chainKey: '', instrument: null, instKey: '', instParamsKey: '', autoKey: '{}' };
      this.tracks.set(id, node);
    }

    const ch = node.channel;
    // Automated volume/pan are driven by applyAutomation instead.
    if (!track.automation?.vol?.length && ch.volume.value !== track.volume) ch.volume.rampTo(track.volume, 0.02);
    if (!track.automation?.pan?.length && ch.pan.value !== track.pan) ch.pan.rampTo(track.pan, 0.02);
    // When a track's automation changes, re-apply base values so removed lanes don't stick.
    const autoKey = JSON.stringify(track.automation ?? {});
    if (autoKey !== node.autoKey) {
      node.autoKey = autoKey;
      for (const d of node.devices.values()) d.paramKey = '';
      node.instParamsKey = '';
    }
    if (ch.mute !== track.mute) ch.mute = track.mute;
    if (ch.solo !== track.solo) ch.solo = track.solo;

    // Instrument. The type key decides when to rebuild; live-updatable
    // instruments (the wavetable synth) take param changes via update().
    if (track.kind === 'instrument') {
      const inst = track.instrument ?? { type: 'synth' as const };
      const sample = samplerAssetId(inst);
      const live = LIVE_UPDATE_TYPES.has(inst.type);
      const paramsKey = JSON.stringify(inst.params ?? {});
      const typeKey = inst.type
        + (sample ? `|${sample}|${!!getBuffer(sample)}` : '')
        + (inst.type === 'synth' ? `|${isSynthReady()}` : '')
        + (live ? '' : `|${paramsKey}`);
      if (typeKey !== node.instKey) {
        node.instrument?.releaseAll();
        node.instrument?.dispose();
        node.instKey = typeKey;
        node.instrument = createInstrument(inst);
        node.instrument.output.connect(node.input);
        node.instParamsKey = paramsKey;
        // MIDI parts close over the instrument; their key includes instKey so they rebuild.
      } else if (paramsKey !== node.instParamsKey) {
        node.instParamsKey = paramsKey;
        node.instrument?.update?.(inst.params ?? {});
      }
      node.instrument?.setBpm?.(bpm);
    } else if (node.instrument) {
      node.instrument.dispose();
      node.instrument = null;
      node.instKey = '';
    }

    this.syncEffects(node, track, bpm);
  }

  private syncEffects(node: TrackNode, track: StudioTrack, bpm: number) {
    const list = (track.effects ?? []).filter((fx) => EFFECT_DEFS[fx.type]);
    let rewire = false;
    const seen = new Set<string>();
    for (const fx of list) {
      seen.add(fx.id);
      const p = resolveParams(fx.type, fx.params);
      const structKey = EFFECT_DEFS[fx.type].structKey(p);
      const paramKey = `${JSON.stringify(p)}@${bpm}`;
      const entry = node.devices.get(fx.id);
      if (!entry || entry.type !== fx.type || entry.device.structKey !== structKey) {
        if (entry) { this.unwire(node); entry.device.dispose(); rewire = true; }
        node.devices.set(fx.id, { device: buildDevice(fx.type, p, bpm), type: fx.type, paramKey, params: p });
        rewire = true;
      } else if (entry.paramKey !== paramKey) {
        entry.device.update(p, bpm);
        entry.paramKey = paramKey;
        entry.params = p;
      }
    }
    for (const [id, entry] of node.devices) {
      if (!seen.has(id)) {
        this.unwire(node);
        entry.device.dispose();
        node.devices.delete(id);
        rewire = true;
      }
    }
    const chainKey = list.filter((fx) => !fx.bypass).map((fx) => `${fx.id}:${node.devices.get(fx.id)!.device.structKey}`).join('|');
    if (rewire || chainKey !== node.chainKey) {
      node.chainKey = chainKey;
      this.unwire(node);
      const chain: Tone.ToneAudioNode[] = [node.input];
      for (const fx of list) {
        if (fx.bypass) continue;
        const d = node.devices.get(fx.id)!.device;
        chain.push(d.input);
        // input→output is internal to the device; wire output to the next stage
        chain.push(d.output);
      }
      chain.push(node.channel);
      for (let i = 0; i < chain.length - 1; i += 2) {
        chain[i].connect(chain[i + 1]);
        node.wiring.push([chain[i], chain[i + 1]]);
      }
    }
  }

  private unwire(node: TrackNode) {
    for (const [from, to] of node.wiring) {
      try { from.disconnect(to); } catch { /* already disconnected */ }
    }
    node.wiring = [];
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
    this.unwire(node);
    node.instrument?.dispose();
    for (const { device } of node.devices.values()) device.dispose();
    node.meter?.dispose();
    node.input.dispose();
    node.channel.dispose();
    this.tracks.delete(id);
  }

  private applyAutomation(time: number) {
    const doc = this.doc;
    if (!doc || this.disposed) return;
    const beat = this.transport.getTicksAtTime(time) / this.transport.PPQ;
    const step = (60 / doc.meta.bpm) / 16;
    for (const [trackId, node] of this.tracks) {
      const lanes = doc.tracks[trackId]?.automation;
      if (!lanes) continue;
      for (const [lane, points] of Object.entries(lanes)) {
        if (!points.length) continue;
        const v = valueAt(points, beat);
        if (lane === 'vol') node.channel.volume.rampTo(v, step, time);
        else if (lane === 'pan') node.channel.pan.rampTo(Math.max(-1, Math.min(1, v)), step, time);
        else if (lane.startsWith('fx:')) {
          const sep = lane.indexOf(':', 3);
          const entry = node.devices.get(lane.slice(3, sep));
          const param = lane.slice(sep + 1);
          if (entry && entry.params[param] !== v) {
            entry.params = { ...entry.params, [param]: v };
            entry.device.update(entry.params, doc.meta.bpm);
            entry.paramKey = ''; // next sync restores/merges base values
          }
        } else if (lane.startsWith('inst:')) {
          node.instrument?.setParam?.(lane.slice(5), v);
        }
      }
    }
  }

  /** Resolves when every track's effect chain is built (needed before offline render). */
  async ready() {
    await Promise.all([...this.tracks.values()].flatMap((t) => [...t.devices.values()].map((d) => d.device.ready)));
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

  /**
   * Playhead at the moment being heard. transport.ticks reads ahead by the
   * scheduling look-ahead; live input should be stamped at the audible time.
   */
  getAudiblePositionBeats(): number {
    return this.transport.getTicksAtTime(Tone.immediate()) / this.transport.PPQ;
  }

  pitchBend(trackId: string, semis: number) {
    this.tracks.get(trackId)?.instrument?.setPitchBend?.(semis);
  }

  modWheel(trackId: string, value: number) {
    this.tracks.get(trackId)?.instrument?.setModWheel?.(value);
  }

  /** Held note from live input (computer keyboard). */
  async noteOn(trackId: string, pitch: number, velocity: number) {
    await Tone.start();
    const inst = this.tracks.get(trackId)?.instrument;
    if (!inst) return;
    const now = Tone.immediate();
    if (inst.noteOn) inst.noteOn(pitch, velocity, now);
    else inst.play(pitch, 0.4, now, velocity);
  }

  noteOff(trackId: string, pitch: number) {
    this.tracks.get(trackId)?.instrument?.noteOff?.(pitch, Tone.immediate());
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

  /** Live knob feedback for instruments that support update(). */
  previewInstrument(trackId: string, params: StudioParams) {
    const node = this.tracks.get(trackId);
    if (!node?.instrument?.update) return;
    node.instrument.update(params);
    node.instParamsKey = '';
  }

  getInstrumentAnalyser(trackId: string): Tone.Analyser | undefined {
    return this.tracks.get(trackId)?.instrument?.analyser;
  }

  getEffectAnalyser(trackId: string, fxId: string): Tone.Analyser | undefined {
    return this.tracks.get(trackId)?.devices.get(fxId)?.device.analyser;
  }

  getEffectReduction(trackId: string, fxId: string): number {
    return this.tracks.get(trackId)?.devices.get(fxId)?.device.getReduction?.() ?? 0;
  }

  /** Live knob feedback before the value is committed to the doc. */
  previewEffect(trackId: string, fxId: string, params: Resolved) {
    const entry = this.tracks.get(trackId)?.devices.get(fxId);
    if (!entry) return;
    entry.device.update(params, this.bpm);
    entry.paramKey = '';
  }

  get sampleRate(): number {
    return Tone.getContext().sampleRate;
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
    this.transport.clear(this.autoEvent);
    this.metronome?.dispose();
    this.click?.dispose();
    this.masterMeter?.dispose();
    this.master.dispose();
    this.transport.cancel(0);
  }
}
