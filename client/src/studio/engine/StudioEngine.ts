import * as Tone from 'tone';
import { tempoMap, bpmAt, spanSec, type TempoMap } from '@abyss/shared';
import type { StudioDoc, StudioTrack, StudioClip, StudioParams, StudioEffect } from '@abyss/shared';
import { createInstrument, samplerAssetId, soundfontAssetId, LIVE_UPDATE_TYPES, type PlayableInstrument } from './instruments';
import { ensureSynthWorklet, isSynthReady } from './wavetable/synthNode';
import { EFFECT_DEFS, resolveParams, buildDevice, type FxDevice, type Resolved } from './effects';
import { getBuffer } from './assetCache';
import { getSoundFont } from './soundfont';
import { valueAt } from './automationMath';
import { resolveOutput, audibleUnderSolo, isReturnOnlySolo, isSidechainCycle, clipPlayback } from './routing';

// Renders a StudioDoc with Tone.js. `sync(doc)` diffs the doc against the
// current audio graph by entity id and rebuilds only what changed, so remote
// edits are cheap. Time in the doc is in beats (quarter notes); a tempo map
// (meta.bpm + doc.tempo) turns beats into seconds.
//
// Graph per track:
//   sources → input → [effects…] → post ─┬→ channel (vol/pan/mute) ─┬→ group input | master in
//                                        └→ sidechain keys           └→ sends → return inputs
// Master:  masterIn → [master effects…] → master (fader) → monitor (local level) → out
//
// Constructed against the *current* Tone context, so building one inside
// Tone.Offline() gives an export renderer with identical sound.

interface DeviceEntry {
  device: FxDevice;
  type: string;
  paramKey: string;
  params: Resolved;
  /** Node currently feeding this device's sidechain input */
  scFrom: Tone.ToneAudioNode | null;
}

/** An effect chain from `input` to `tail` (tracks and the master bus). */
interface ChainHost {
  input: Tone.Gain;
  tail: Tone.ToneAudioNode;
  /** Live effect devices by effect id (bypassed ones stay alive, unwired) */
  devices: Map<string, DeviceEntry>;
  /** Current wiring, so a rewire disconnects exactly what it connected */
  wiring: [Tone.ToneAudioNode, Tone.ToneAudioNode][];
  chainKey: string;
}

interface TrackNode extends ChainHost {
  /** End of the effect chain, pre-fader (sidechain taps here) */
  post: Tone.Gain;
  channel: Tone.Channel;
  /** Dry output gate between channel and outTarget (muted when soloing returns only) */
  dryOut: Tone.Gain;
  meter: Tone.Meter | null;
  instrument: PlayableInstrument | null;
  instKey: string;
  instParamsKey: string;
  autoKey: string;
  /** Where dryOut is connected (a group's input or the master input) */
  outTarget: Tone.ToneAudioNode | null;
  sends: Map<string, { gain: Tone.Gain; target: Tone.ToneAudioNode }>;
}

type AnyPlayer = Tone.Player | Tone.GrainPlayer;

interface ClipNode {
  key: string;
  player?: AnyPlayer;
  /** Transport event that starts the player at the clip's start */
  event?: number;
  part?: Tone.Part;
  /** Timeline playback info for resuming mid-clip */
  play?: { startBeat: number; endBeat: number; srcOffset: number; timelineSec: number; rate: number; warp: boolean; reverse: boolean; bufDur: number; srcDur: number };
}

const reversed = new WeakMap<AudioBuffer, AudioBuffer>();
function reversedBuffer(buf: AudioBuffer): AudioBuffer {
  let r = reversed.get(buf);
  if (!r) {
    r = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) r.copyToChannel(buf.getChannelData(c).slice().reverse(), c);
    reversed.set(buf, r);
  }
  return r;
}

function midiClipKey(c: StudioClip, instKey: string): string {
  // Notes object identity changes on any note edit (copy-on-write), but
  // stringify keeps remote no-op updates from rebuilding.
  return `${c.trackId}|${c.start}|${c.length}|${c.gain}|${c.mute}|${instKey}|${JSON.stringify(c.notes ?? {})}`;
}

/**
 * The engine currently driving each transport. Tone's transport is a global
 * singleton (per context), so an engine that was never disposed (a crashed
 * view) would keep it running with nothing on screen able to stop it.
 */
const liveEngines = new WeakMap<object, StudioEngine>();

export class StudioEngine {
  readonly transport: ReturnType<typeof Tone.getTransport>;
  /** Everything routed to master lands here, before the master effects. */
  private readonly masterIn: Tone.Gain;
  // A plain Volume, not a Channel: Tone's solo would silence the master bus.
  private readonly master: Tone.Volume;
  private readonly masterHost: ChainHost;
  /** Local listening level (after the mix and the metronome); never exported. */
  private readonly monitor: Tone.Volume;
  private readonly masterMeter: Tone.Meter | null;
  private readonly tracks = new Map<string, TrackNode>();
  private readonly clips = new Map<string, ClipNode>();
  private readonly withMeters: boolean;
  private readonly isOffline: boolean;
  private doc: StudioDoc | null = null;
  private map: TempoMap | null = null;
  private tempoKey = '';
  private tempoEvents: number[] = [];
  private metronome: Tone.Loop | null = null;
  private click: Tone.Synth | null = null;
  private metronomeOn = false;
  private disposed = false;
  private autoEvent = -1;
  private playSeq = 0;
  private readonly liveNotes = new Set<string>();
  private countInCancel: (() => void) | null = null;
  private readonly onStart: (time: number) => void;
  private readonly onStopLike: (time: number) => void;
  private readonly onLoopEnd: (time: number) => void;
  private readonly onLoop: (time: number) => void;

  constructor(opts: { meters?: boolean } = {}) {
    this.withMeters = opts.meters ?? true;
    this.isOffline = Tone.getContext().isOffline;
    this.transport = Tone.getTransport();
    const prev = liveEngines.get(this.transport);
    if (prev) prev.dispose();
    if (this.transport.state !== 'stopped') this.transport.stop();
    liveEngines.set(this.transport, this);
    this.monitor = new Tone.Volume(0).toDestination();
    this.master = new Tone.Volume(0).connect(this.monitor);
    this.masterIn = new Tone.Gain(1);
    this.masterIn.connect(this.master);
    this.masterHost = { input: this.masterIn, tail: this.master, devices: new Map(), wiring: [[this.masterIn, this.master]], chainKey: '' };
    this.masterMeter = this.withMeters ? new Tone.Meter({ smoothing: 0.85 }) : null;
    if (this.masterMeter) this.master.connect(this.masterMeter);
    // Automation runs on the transport clock (works offline for export too).
    this.autoEvent = this.transport.scheduleRepeat((time) => this.applyAutomation(time), '64n', 0);
    // Audio clips are started by the engine (not Tone's sync()), so they can
    // resume mid-clip correctly at any playback rate and across tempo changes.
    this.onStart = (time) => this.resumeClips(time);
    this.onStopLike = (time) => this.stopPlayers(time);
    this.onLoopEnd = (time) => {
      this.stopPlayers(time);
      for (const t of this.tracks.values()) t.instrument?.releaseAll();
    };
    this.onLoop = (time) => {
      if (!this.map || !this.doc) return;
      const b = bpmAt(this.map, this.doc.meta.loopStart);
      this.transport.bpm.setValueAtTime(b, time);
      this.applyBpmToDevices(b, time);
    };
    this.transport.on('start', this.onStart);
    this.transport.on('loopStart', this.onStart);
    this.transport.on('stop', this.onStopLike);
    this.transport.on('pause', this.onStopLike);
    this.transport.on('loopEnd', this.onLoopEnd);
    this.transport.on('loop', this.onLoop);
    // Wavetable synth tracks (and sidechain compressors) wait for the worklet, then rebuild.
    if (!isSynthReady()) {
      ensureSynthWorklet()
        .then(() => { if (!this.disposed) this.refresh(); })
        .catch((e) => console.warn('[studio] audio worklet unavailable', e));
    }
  }

  // ───────────────────────── Doc sync ─────────────────────────

  sync(doc: StudioDoc) {
    if (this.disposed) return;
    this.doc = doc;
    const { meta } = doc;
    const ppq = this.transport.PPQ;
    this.syncTempo(doc);

    this.transport.timeSignature = [meta.timeSigNum, meta.timeSigDen];
    const loopOk = meta.loopEnabled && meta.loopEnd > meta.loopStart;
    this.transport.loop = loopOk;
    if (loopOk) {
      this.transport.loopStart = `${Math.round(meta.loopStart * ppq)}i`;
      this.transport.loopEnd = `${Math.round(meta.loopEnd * ppq)}i`;
    }

    // Tracks
    const curBpm = this.map ? bpmAt(this.map, this.getPositionBeats()) : meta.bpm;
    for (const [id, track] of Object.entries(doc.tracks)) this.syncTrack(id, track, curBpm, doc);
    for (const id of [...this.tracks.keys()]) {
      if (!doc.tracks[id]) this.disposeTrack(id);
    }
    this.syncEffects(this.masterHost, meta.masterEffects, curBpm, doc, '');
    const masterVol = meta.masterVolume ?? 0;
    if (this.isOffline) this.master.volume.value = masterVol;
    else if (Math.abs(this.master.volume.value - masterVol) > 1e-4) this.master.volume.rampTo(masterVol, 0.02);
    this.route(doc);

    // Clips
    for (const [id, clip] of Object.entries(doc.clips)) {
      if (!this.tracks.has(clip.trackId)) continue;
      if (clip.kind === 'audio') this.syncAudioClip(id, clip);
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

  private applyBpmToDevices(bpm: number, time?: number) {
    for (const t of this.tracks.values()) {
      t.instrument?.setBpm?.(bpm, time);
      for (const e of t.devices.values()) {
        if (e.type === 'delay') e.device.update(e.params, bpm, time, time !== undefined ? 0.05 : undefined);
      }
    }
    for (const e of this.masterHost.devices.values()) {
      if (e.type === 'delay') e.device.update(e.params, bpm, time, time !== undefined ? 0.05 : undefined);
    }
  }

  private syncTempo(doc: StudioDoc) {
    const map = tempoMap(doc);
    this.map = map;
    const key = JSON.stringify(map.segs);
    if (key === this.tempoKey) return;
    this.tempoKey = key;
    for (const id of this.tempoEvents) this.transport.clear(id);
    this.tempoEvents = [];
    const ppq = this.transport.PPQ;
    for (const seg of map.segs.slice(1)) {
      this.tempoEvents.push(this.transport.schedule((time) => {
        this.transport.bpm.setValueAtTime(seg.bpm, time);
        this.applyBpmToDevices(seg.bpm, time);
      }, `${Math.round(seg.beat * ppq)}i`));
    }
    const now = bpmAt(map, this.getPositionBeats());
    this.transport.bpm.cancelScheduledValues(Tone.now());
    if (this.isPlaying) this.transport.bpm.setValueAtTime(now, Tone.now());
    else this.transport.bpm.value = now;
    this.applyBpmToDevices(now);
  }

  private syncTrack(id: string, track: StudioTrack, bpm: number, doc: StudioDoc) {
    let node = this.tracks.get(id);
    if (!node) {
      const input = new Tone.Gain(1);
      const post = new Tone.Gain(1);
      const channel = new Tone.Channel({ volume: track.volume, pan: track.pan, mute: track.mute });
      const dryOut = new Tone.Gain(1);
      const meter = this.withMeters ? new Tone.Meter({ smoothing: 0.8 }) : null;
      if (meter) channel.connect(meter);
      input.connect(post);
      post.connect(channel);
      channel.connect(dryOut);
      node = {
        input, post, tail: post, channel, dryOut, meter, devices: new Map(), wiring: [[input, post]], chainKey: '',
        instrument: null, instKey: '', instParamsKey: '', autoKey: '{}', outTarget: null, sends: new Map(),
      };
      this.tracks.set(id, node);
    }

    const ch = node.channel;
    // Automated volume/pan are driven by applyAutomation instead.
    if (!track.automation?.vol?.length) {
      if (this.isOffline) ch.volume.value = track.volume;
      else if (Math.abs(ch.volume.value - track.volume) > 1e-4) ch.volume.rampTo(track.volume, 0.02);
    }
    if (!track.automation?.pan?.length) {
      if (this.isOffline) ch.pan.value = track.pan;
      else if (Math.abs(ch.pan.value - track.pan) > 1e-4) ch.pan.rampTo(track.pan, 0.02);
    }
    // When a track's automation changes, re-apply base values so removed lanes don't stick.
    const autoKey = JSON.stringify(track.automation ?? {});
    if (autoKey !== node.autoKey) {
      node.autoKey = autoKey;
      for (const d of node.devices.values()) d.paramKey = '';
      node.instParamsKey = '';
    }

    // Instrument. The type key decides when to rebuild; live-updatable
    // instruments take param changes via update().
    if (track.kind === 'instrument') {
      const inst = track.instrument ?? { type: 'synth' as const };
      const sample = samplerAssetId(inst);
      const sf = soundfontAssetId(inst);
      const live = LIVE_UPDATE_TYPES.has(inst.type);
      const paramsKey = JSON.stringify(inst.params ?? {});
      const typeKey = inst.type
        + (sample ? `|${sample}|${!!getBuffer(sample)}` : '')
        + (sf ? `|${sf}|${!!getSoundFont(sf)}` : '')
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

    this.syncEffects(node, track.effects, bpm, doc, id);
  }

  private syncEffects(host: ChainHost, effects: StudioEffect[] | undefined, bpm: number, doc: StudioDoc, hostTrackId: string) {
    const list = (effects ?? []).filter((fx) => EFFECT_DEFS[fx.type]);
    let rewire = false;
    const seen = new Set<string>();
    for (const fx of list) {
      seen.add(fx.id);
      const p = resolveParams(fx.type, fx.params);
      // Treat a deleted or cyclic sidechain key track as off so the compressor keeps working.
      if (fx.type === 'compressor' && typeof p.sidechain === 'string' && p.sidechain && isSidechainCycle(doc, hostTrackId, p.sidechain)) {
        p.sidechain = '';
      }
      const structKey = EFFECT_DEFS[fx.type].structKey(p);
      const paramKey = `${JSON.stringify(p)}@${bpm}`;
      const entry = host.devices.get(fx.id);
      if (!entry || entry.type !== fx.type || entry.device.structKey !== structKey) {
        if (entry) { this.unwire(host); this.disposeDevice(entry); rewire = true; }
        host.devices.set(fx.id, { device: buildDevice(fx.type, p, bpm), type: fx.type, paramKey, params: p, scFrom: null });
        rewire = true;
      } else if (entry.paramKey !== paramKey) {
        entry.device.update(p, bpm);
        entry.paramKey = paramKey;
        entry.params = p;
      }
    }
    for (const [id, entry] of host.devices) {
      if (!seen.has(id)) {
        this.unwire(host);
        this.disposeDevice(entry);
        host.devices.delete(id);
        rewire = true;
      }
    }
    const chainKey = list.filter((fx) => !fx.bypass).map((fx) => `${fx.id}:${host.devices.get(fx.id)!.device.structKey}`).join('|');
    if (rewire || chainKey !== host.chainKey) {
      host.chainKey = chainKey;
      this.unwire(host);
      const chain: Tone.ToneAudioNode[] = [host.input];
      for (const fx of list) {
        if (fx.bypass) continue;
        const d = host.devices.get(fx.id)!.device;
        chain.push(d.input);
        // input→output is internal to the device; wire output to the next stage
        chain.push(d.output);
      }
      chain.push(host.tail);
      for (let i = 0; i < chain.length - 1; i += 2) {
        chain[i].connect(chain[i + 1]);
        host.wiring.push([chain[i], chain[i + 1]]);
      }
    }
  }

  private disposeDevice(entry: DeviceEntry) {
    if (entry.scFrom && entry.device.sidechain) {
      try { entry.scFrom.disconnect(entry.device.sidechain); } catch { /* gone */ }
    }
    entry.scFrom = null;
    entry.device.dispose();
  }

  private unwire(host: ChainHost) {
    for (const [from, to] of host.wiring) {
      try { from.disconnect(to); } catch { /* already disconnected */ }
    }
    host.wiring = [];
  }

  /** Outputs (groups / master), sends, sidechain keys and solo-in-place muting. */
  private route(doc: StudioDoc) {
    const audible = audibleUnderSolo(doc);
    const returnOnly = isReturnOnlySolo(doc);
    for (const [id, node] of this.tracks) {
      const track = doc.tracks[id];
      if (!track) continue;

      const dest = resolveOutput(doc, id);
      const target = dest ? this.tracks.get(dest)!.input : this.masterIn;
      if (node.outTarget !== target) {
        if (node.outTarget) { try { node.dryOut.disconnect(node.outTarget); } catch { /* disposed with its track */ } }
        node.dryOut.connect(target);
        node.outTarget = target;
      }

      // Sends (post-fader) into return tracks.
      const want = new Map<string, number>();
      if (track.kind !== 'return') {
        for (const [rid, db] of Object.entries(track.sends ?? {})) {
          if (doc.tracks[rid]?.kind === 'return' && rid !== id && db > -60) want.set(rid, db);
        }
        // An automated send needs its node even while its base level is off.
        for (const [lane, pts] of Object.entries(track.automation ?? {})) {
          const rid = lane.startsWith('send:') ? lane.slice(5) : '';
          if (rid && pts.length && doc.tracks[rid]?.kind === 'return' && rid !== id && !want.has(rid)) want.set(rid, track.sends?.[rid] ?? -60);
        }
      }
      for (const [rid, s] of node.sends) {
        const rt = this.tracks.get(rid);
        if (!want.has(rid) || !rt || rt.input !== s.target) {
          try { node.channel.disconnect(s.gain); } catch { /* */ }
          s.gain.dispose();
          node.sends.delete(rid);
        }
      }
      for (const [rid, db] of want) {
        const g = Tone.dbToGain(db);
        const s = node.sends.get(rid);
        // Automated sends are driven by applyAutomation.
        if (s) {
          if (!track.automation?.[`send:${rid}`]?.length && Math.abs(s.gain.gain.value - g) > 1e-6) {
            if (this.isOffline) s.gain.gain.value = g;
            else s.gain.gain.rampTo(g, 0.02);
          }
          continue;
        }
        const target = this.tracks.get(rid)!.input;
        const gain = new Tone.Gain(g);
        node.channel.connect(gain);
        gain.connect(target);
        node.sends.set(rid, { gain, target });
      }

      // When soloing only return track(s), keep source tracks unmuted so their
      // sends still feed the soloed return(s), while muting dry output at master.
      const mute = returnOnly && track.kind !== 'return' ? track.mute : (track.mute || !audible.has(id));
      if (node.channel.mute !== mute) node.channel.mute = mute;
      const dryGain = returnOnly && track.kind !== 'return' && dest === '' ? 0 : 1;
      if (node.dryOut.gain.value !== dryGain) node.dryOut.gain.value = dryGain;
    }

    // Sidechain keys: compressor param `sidechain` names the key track (tapped pre-fader).
    const hostEntries: [string, ChainHost][] = [...this.tracks.entries(), ['', this.masterHost]];
    for (const [hostTrackId, host] of hostEntries) {
      for (const entry of host.devices.values()) {
        const sc = entry.device.sidechain;
        if (!sc) continue;
        const keyId = typeof entry.params.sidechain === 'string' ? entry.params.sidechain : '';
        const valid = keyId && !isSidechainCycle(doc, hostTrackId, keyId);
        const from = valid ? this.tracks.get(keyId)?.post ?? null : null;
        if (entry.scFrom === from) continue;
        if (entry.scFrom) { try { entry.scFrom.disconnect(sc); } catch { /* */ } }
        if (from) from.connect(sc);
        entry.scFrom = from;
      }
    }
  }

  private syncAudioClip(id: string, clip: StudioClip) {
    const buffer = clip.assetId ? getBuffer(clip.assetId) : undefined;
    const map = this.map!;
    const pb = clipPlayback(clip, map);
    const key = `${clip.trackId}|${clip.start}|${clip.length}|${clip.assetId}|${clip.offset}|${clip.gain}|${clip.fadeIn}|${clip.fadeOut}|${clip.mute}|${clip.warp}|${clip.srcBpm}|${clip.pitch}|${clip.reverse}|${pb.rate}|${pb.timelineSec}|${!!buffer}`;
    const existing = this.clips.get(id);
    if (existing?.key === key) return;
    this.disposeClip(id);
    if (!buffer || clip.mute) {
      this.clips.set(id, { key });
      return;
    }

    const offset = Math.max(0, clip.offset ?? 0);
    const srcDur = Math.min(pb.timelineSec * pb.rate, buffer.duration - offset);
    if (srcDur <= 0) {
      this.clips.set(id, { key });
      return;
    }
    const buf = clip.reverse ? reversedBuffer(buffer) : buffer;
    // Reversed: the same source region, read from the other end.
    const srcOffset = clip.reverse ? Math.max(0, buffer.duration - offset - srcDur) : offset;
    let player: AnyPlayer;
    if (pb.warp) {
      const gp = new Tone.GrainPlayer({ url: new Tone.ToneAudioBuffer(buf), grainSize: 0.08, overlap: 0.04 });
      gp.playbackRate = pb.rate;
      gp.detune = (clip.pitch ?? 0) * 100;
      player = gp;
    } else {
      const p = new Tone.Player(new Tone.ToneAudioBuffer(buf));
      p.playbackRate = pb.rate;
      const timelineDur = srcDur / pb.rate;
      p.fadeIn = Math.min(clip.fadeIn ?? 0, timelineDur / 2);
      p.fadeOut = Math.min(clip.fadeOut ?? 0, timelineDur / 2);
      player = p;
    }
    player.volume.value = clip.gain ?? 0;
    player.connect(this.tracks.get(clip.trackId)!.input);
    const play = {
      startBeat: clip.start, endBeat: clip.start + clip.length, srcOffset, timelineSec: srcDur / pb.rate,
      rate: pb.rate, warp: pb.warp, reverse: !!clip.reverse, bufDur: buffer.duration, srcDur,
    };
    const event = this.transport.schedule((time) => this.startPlayer(player, play, time, 0), `${Math.round(clip.start * this.transport.PPQ)}i`);
    const node: ClipNode = { key, player, event, play };
    this.clips.set(id, node);
    // Edited while playing with the playhead inside it: pick it up now.
    if (this.isPlaying) {
      const beat = this.getPositionBeats();
      if (beat > play.startBeat + 1e-6 && beat < play.endBeat) this.startPlayer(player, play, Tone.now() + 0.05, spanSec(map, play.startBeat, beat));
    }
  }

  /** Start a clip's player `into` timeline seconds after the clip start. */
  private startPlayer(player: AnyPlayer, play: NonNullable<ClipNode['play']>, time: number, into: number) {
    const remaining = play.timelineSec - into;
    if (remaining <= 0.001) return;
    const srcInto = into * play.rate;
    try {
      // Tone.GrainPlayer._start divides offset by (grainSize / playbackRate),
      // multiplying buffer offset by playbackRate — divide by rate to compensate.
      if (player instanceof Tone.GrainPlayer) player.start(time, (play.srcOffset + srcInto) / play.rate, remaining);
      else player.start(time, play.srcOffset + srcInto, play.srcDur - srcInto);
    } catch (e) { console.warn('[studio] clip start failed', e); }
  }

  private resumeClips(time: number) {
    if (!this.map) return;
    const beat = this.transport.getTicksAtTime(time) / this.transport.PPQ;
    for (const c of this.clips.values()) {
      if (!c.player || !c.play) continue;
      // Clips starting exactly here are started by their own transport event.
      if (beat > c.play.startBeat + 1e-6 && beat < c.play.endBeat - 1e-6) {
        this.startPlayer(c.player, c.play, time, spanSec(this.map, c.play.startBeat, beat));
      }
    }
  }

  private stopPlayers(time: number) {
    for (const c of this.clips.values()) {
      if (c.player) { try { c.player.stop(time); } catch { /* not started */ } }
    }
  }

  private syncMidiClip(id: string, clip: StudioClip) {
    const track = this.tracks.get(clip.trackId);
    if (!track?.instrument) { this.disposeClip(id); return; }
    const key = midiClipKey(clip, track.instKey);
    if (this.clips.get(id)?.key === key) return;
    this.disposeClip(id);
    if (clip.mute) { this.clips.set(id, { key }); return; }

    const ppq = this.transport.PPQ;
    const instrument = track.instrument;
    const gain = Tone.dbToGain(clip.gain ?? 0);
    const events = Object.values(clip.notes ?? {})
      .filter((n) => n.start >= 0 && n.start < clip.length && n.len > 0)
      .map((n) => {
        const absStart = clip.start + n.start;
        // Notes are cut at the clip boundary
        const absEnd = clip.start + Math.min(clip.length, n.start + n.len);
        return {
          time: `${Math.round(n.start * ppq)}i`,
          pitch: n.pitch,
          absStart,
          absEnd,
          vel: Math.min(1, n.vel * gain),
        };
      });
    const part = new Tone.Part((time, ev) => {
      const dur = this.map ? Math.max(0.005, spanSec(this.map, ev.absStart, ev.absEnd)) : 0.1;
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
    if (node.event !== undefined) this.transport.clear(node.event);
    if (node.player) {
      try { node.player.stop(); } catch { /* not started */ }
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
    for (const entry of node.devices.values()) this.disposeDevice(entry);
    for (const s of node.sends.values()) s.gain.dispose();
    // Anything keyed from this track loses its key.
    for (const host of [...this.tracks.values(), this.masterHost]) {
      for (const e of host.devices.values()) if (e.scFrom === node.post) e.scFrom = null;
    }
    node.meter?.dispose();
    node.input.dispose();
    node.post.dispose();
    node.channel.dispose();
    node.dryOut.dispose();
    this.tracks.delete(id);
    // Tracks that fed this one (a group) are re-routed by route().
    for (const t of this.tracks.values()) if (t.outTarget === node.input) t.outTarget = null;
  }

  private applyAutomation(time: number) {
    const doc = this.doc;
    if (!doc || this.disposed) return;
    const beat = this.transport.getTicksAtTime(time) / this.transport.PPQ;
    const bpm = this.map ? bpmAt(this.map, beat) : this.transport.bpm.getValueAtTime(time);
    const step = (60 / bpm) / 16;
    for (const [trackId, node] of this.tracks) {
      const lanes = doc.tracks[trackId]?.automation;
      if (!lanes) continue;
      for (const [lane, points] of Object.entries(lanes)) {
        if (!points.length) continue;
        const v = valueAt(points, beat);
        if (lane === 'vol') node.channel.volume.rampTo(v, step, time);
        else if (lane === 'pan') node.channel.pan.rampTo(Math.max(-1, Math.min(1, v)), step, time);
        else if (lane.startsWith('send:')) {
          node.sends.get(lane.slice(5))?.gain.gain.rampTo(Tone.dbToGain(v), step, time);
        } else if (lane.startsWith('fx:')) {
          const sep = lane.indexOf(':', 3);
          const entry = node.devices.get(lane.slice(3, sep));
          const param = lane.slice(sep + 1);
          if (entry && entry.params[param] !== v) {
            entry.params = { ...entry.params, [param]: v };
            entry.device.update(entry.params, bpm, time, step);
            entry.paramKey = ''; // next sync restores/merges base values
          }
        } else if (lane.startsWith('inst:')) {
          node.instrument?.setParam?.(lane.slice(5), v, time, step);
        }
      }
    }
  }

  /** Resolves when every effect chain is built (needed before offline render). */
  async ready() {
    const hosts: ChainHost[] = [...this.tracks.values(), this.masterHost];
    await Promise.all(hosts.flatMap((t) => [...t.devices.values()].map((d) => d.device.ready)));
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

  private setTempoFor(beats: number) {
    if (!this.map) return;
    const bpm = bpmAt(this.map, beats);
    this.transport.bpm.cancelScheduledValues(Tone.now());
    if (this.transport.bpm.value !== bpm) this.transport.bpm.value = bpm;
    this.applyBpmToDevices(bpm);
  }

  async play(fromBeats: number): Promise<boolean> {
    const seq = ++this.playSeq;
    await Tone.start();
    if (this.disposed || seq !== this.playSeq) return false;
    const ticks = Math.max(0, Math.round(fromBeats * this.transport.PPQ));
    this.setTempoFor(fromBeats);
    if (this.isPlaying) {
      this.stopPlayers(Tone.now());
      for (const t of this.tracks.values()) t.instrument?.releaseAll();
      this.transport.ticks = ticks;
      return true;
    }
    this.transport.ticks = ticks;
    // Small lookahead so the first events aren't dropped.
    this.transport.start('+0.05');
    return true;
  }

  stop() {
    this.playSeq++;
    this.cancelCountIn();
    // Always pause (even if state === 'stopped') to cancel a queued '+0.05' start.
    try { this.transport.pause(); } catch { /* */ }
    this.stopPlayers(Tone.now());
    for (const t of this.tracks.values()) t.instrument?.releaseAll();
  }

  seek(beats: number) {
    this.setTempoFor(beats);
    if (this.isPlaying) {
      this.stopPlayers(Tone.now());
      for (const t of this.tracks.values()) t.instrument?.releaseAll();
    }
    this.transport.ticks = Math.max(0, Math.round(beats * this.transport.PPQ));
  }

  private ensureClick() {
    if (this.click) return this.click;
    this.click = new Tone.Synth({ oscillator: { type: 'square' }, envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 } });
    this.click.volume.value = -10;
    this.click.connect(this.monitor);
    return this.click;
  }

  setMetronome(on: boolean) {
    this.metronomeOn = on;
    if (on && !this.metronome) {
      this.ensureClick();
      // Ticks every 16th; clicks on each beat of the current signature.
      this.metronome = new Tone.Loop((time) => {
        const map = this.map;
        if (!map) return;
        const beat = this.transport.getTicksAtTime(time) / this.transport.PPQ;
        const sig = map.sigs.length === 1 ? map.sigs[0] : map.sigs.reduce((a, s) => (s.beat <= beat + 1e-6 ? s : a), map.sigs[0]);
        const unit = 4 / sig.den;
        const barLen = sig.num * unit;
        const inBar = (((beat - sig.beat) % barLen) + barLen) % barLen;
        const r = inBar / unit;
        if (Math.abs(r - Math.round(r)) > 1e-3) return;
        this.click?.triggerAttackRelease(Math.round(r) % sig.num === 0 ? 'C6' : 'G5', 0.03, time);
      }, '16n').start(0);
    } else if (!on && this.metronome) {
      this.metronome.dispose();
      this.metronome = null;
    }
  }

  get metronomeEnabled() {
    return this.metronomeOn;
  }

  /** Cancels any active count-in immediately. */
  cancelCountIn() {
    const cancel = this.countInCancel;
    if (!cancel) return;
    this.countInCancel = null;
    cancel();
  }

  /**
   * Clicks `bars` bars at the tempo / signature of `atBeats`, starting now.
   * Resolves with the end context time, or `null` if cancelled / disposed.
   */
  async countIn(atBeats: number, bars: number): Promise<number | null> {
    this.cancelCountIn();
    let aborted = false;
    this.countInCancel = () => { aborted = true; };
    await Tone.start();
    if (this.disposed || aborted) { this.countInCancel = null; return null; }
    const map = this.map;
    const bpm = map ? bpmAt(map, atBeats) : this.bpm;
    const sig = map ? map.sigs.reduce((a, s) => (s.beat <= atBeats + 1e-6 ? s : a), map.sigs[0]) : { num: 4, den: 4 };
    const beatSec = (60 / bpm) * (4 / sig.den);
    const click = this.ensureClick();
    const t0 = Tone.now() + 0.08;
    const n = sig.num * bars;
    for (let i = 0; i < n; i++) click.triggerAttackRelease(i % sig.num === 0 ? 'C6' : 'G5', 0.03, t0 + i * beatSec);
    const end = t0 + n * beatSec;
    return await new Promise<number | null>((resolve) => {
      const done = (val: number | null) => {
        if (this.countInCancel === cancel) this.countInCancel = null;
        window.clearTimeout(timer);
        resolve(val);
      };
      const cancel = () => {
        // Recreate click on next use so already-scheduled clicks stop immediately.
        if (this.click && !this.metronome) { try { this.click.dispose(); } catch { /* */ } this.click = null; }
        done(null);
      };
      const timer = window.setTimeout(() => done(this.disposed ? null : end), Math.max(0, (end - Tone.now()) * 1000 - 60));
      this.countInCancel = cancel;
    });
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

  /** Held note from live input (computer keyboard / MIDI). */
  async noteOn(trackId: string, pitch: number, velocity: number) {
    const key = `${trackId}:${pitch}`;
    this.liveNotes.add(key);
    await Tone.start();
    // If noteOff arrived while waiting for Tone.start(), don't leave a stuck note.
    if (this.disposed || !this.liveNotes.has(key)) return;
    const inst = this.tracks.get(trackId)?.instrument;
    if (!inst) return;
    const now = Tone.immediate();
    if (inst.noteOn) inst.noteOn(pitch, velocity, now);
    else inst.play(pitch, 0.4, now, velocity);
  }

  noteOff(trackId: string, pitch: number) {
    this.liveNotes.delete(`${trackId}:${pitch}`);
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

  private monitored: { node: AudioNode; trackId: string } | null = null;

  /** Route a live input into a track's chain (its effects, volume, pan), or stop. */
  monitorInput(trackId: string | null, node: AudioNode | null) {
    const cur = this.monitored;
    if (cur && cur.trackId === trackId && cur.node === node && this.tracks.has(cur.trackId)) return;
    if (cur) {
      const t = this.tracks.get(cur.trackId);
      try { if (t) Tone.disconnect(cur.node, t.input); } catch { /* already gone */ }
      this.monitored = null;
    }
    if (!trackId || !node || this.disposed) return;
    const t = this.tracks.get(trackId);
    if (!t) return;
    Tone.connect(node, t.input);
    this.monitored = { node, trackId };
  }

  previewTrackVolume(trackId: string, db: number) {
    this.tracks.get(trackId)?.channel.volume.rampTo(db, 0.02);
  }

  previewTrackPan(trackId: string, pan: number) {
    this.tracks.get(trackId)?.channel.pan.rampTo(pan, 0.02);
  }

  previewSend(trackId: string, returnId: string, db: number) {
    this.tracks.get(trackId)?.sends.get(returnId)?.gain.gain.rampTo(Tone.dbToGain(db), 0.02);
  }

  previewMasterVolume(db: number) {
    this.master.volume.rampTo(db, 0.02);
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

  /** `trackId` '' (or MASTER_ID) addresses the master bus. */
  private host(trackId: string): ChainHost | undefined {
    return trackId === '' || trackId === MASTER_ID ? this.masterHost : this.tracks.get(trackId);
  }

  getEffectAnalyser(trackId: string, fxId: string): Tone.Analyser | undefined {
    return this.host(trackId)?.devices.get(fxId)?.device.analyser;
  }

  getEffectReduction(trackId: string, fxId: string): number {
    return this.host(trackId)?.devices.get(fxId)?.device.getReduction?.() ?? 0;
  }

  /** Live knob feedback before the value is committed to the doc. */
  previewEffect(trackId: string, fxId: string, params: Resolved) {
    const entry = this.host(trackId)?.devices.get(fxId);
    if (!entry) return;
    entry.device.update(params, this.bpm);
    entry.paramKey = '';
  }

  get sampleRate(): number {
    return Tone.getContext().sampleRate;
  }

  /** Your own listening level in dB (−Infinity mutes). Affects nothing collaborators hear. */
  setMonitorVolume(db: number) {
    if (!Number.isFinite(db)) { this.monitor.mute = true; return; }
    this.monitor.mute = false;
    this.monitor.volume.rampTo(db, 0.02);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (liveEngines.get(this.transport) === this) liveEngines.delete(this.transport);
    this.monitorInput(null, null);
    // Silence first, so a failure further down can't leave anything audible.
    const safe = (fn: () => void) => { try { fn(); } catch (e) { console.warn('[studio] dispose step failed', e); } };
    safe(() => this.monitor.disconnect());
    safe(() => this.stop());
    safe(() => { if (this.transport.state !== 'stopped') this.transport.stop(); });
    safe(() => {
      this.transport.off('start', this.onStart);
      this.transport.off('loopStart', this.onStart);
      this.transport.off('stop', this.onStopLike);
      this.transport.off('pause', this.onStopLike);
      this.transport.off('loopEnd', this.onLoopEnd);
      this.transport.off('loop', this.onLoop);
    });
    for (const id of [...this.clips.keys()]) safe(() => this.disposeClip(id));
    for (const id of [...this.tracks.keys()]) safe(() => this.disposeTrack(id));
    for (const e of this.masterHost.devices.values()) safe(() => this.disposeDevice(e));
    for (const id of this.tempoEvents) safe(() => this.transport.clear(id));
    safe(() => this.transport.clear(this.autoEvent));
    safe(() => this.metronome?.dispose());
    safe(() => this.click?.dispose());
    safe(() => this.masterMeter?.dispose());
    safe(() => this.masterIn.dispose());
    safe(() => this.master.dispose());
    safe(() => this.monitor.dispose());
    safe(() => this.transport.cancel(0));
  }
}

/** Pseudo track id the inspector uses for the master bus. */
export const MASTER_ID = '__master__';
