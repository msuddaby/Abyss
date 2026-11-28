import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Tone from 'tone';
import {
  useStudioStore, useAuthStore, useServerStore, useToastStore, getApiBase,
  hasChannelPermission, Permission, studioId, sortedTrackIds, arrangementEnd, tempoMap, beatToSec, secToBeat,
} from '@abyss/shared';
import type { StudioOp, StudioClip, StudioAsset, StudioParams, StudioTrack } from '@abyss/shared';
import ConfirmModal from '../components/ConfirmModal';
import { StudioEngine, MASTER_ID } from './engine/StudioEngine';
import { loadAsset, onAssetLoaded } from './engine/assetCache';
import { getSoundFont, isSoundFontAsset, isSoundFontFile, loadSoundFont } from './engine/soundfont';
import { renderProjectToWav, renderStemsZip } from './engine/exportWav';
import { EFFECT_DEFS } from './engine/effects';
import { exportMidi } from './midiExport';
import { usedAssetIds } from './engine/instruments';
import StudioArrange from './StudioArrange';
import PianoRoll from './PianoRoll';
import StudioAssetBin from './StudioAssetBin';
import StudioTrackInspector from './StudioTrackInspector';
import { masterTrack } from './engine/routing';
import StudioShortcutsModal from './StudioShortcutsModal';
import { setAutomationContext } from './automation';
import { useStudioInput, inputTargets } from './useStudioInput';
import { restoreMidi, setMidiHandler } from './midiInput';
import StudioMidiMenu from './StudioMidiMenu';
import StudioInputMenu from './StudioInputMenu';
import StudioHistoryPanel from './StudioHistoryPanel';
import StudioClipProps from './StudioClipProps';
import { useLiveInput, useInputPrefs } from './audioInput';
import MidiImportModal from './MidiImportModal';
import { parseMidi, midiImportOps, batchOps, isMidiFile, type MidiFileInfo } from './midiImport';
import { useStudioRecorder, getRecordLatencyMs, setRecordLatencyMs } from './useStudioRecorder';
import {
  SNAP_OPTIONS, snapSize, formatPosition, barBeats, nextTrackOrder, nextTrackColor,
  keyBelongsToTarget, colorForUser, audioClipOp, sliceClip, memberName, clipFitsTrack, barFloor, syncHeaderWidth, uploadAudioFiles,
} from './studioUtils';

const MAX_TRACKS = 48;
const COUNT_IN_KEY = 'studio.countIn';

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

interface Props {
  channelId: string;
  /** Embedded in a voice channel: smaller default panels */
  compact?: boolean;
}

type PanelTab = 'audio' | 'track' | 'editor' | 'history' | 'master';

/** Ableton-style computer MIDI keyboard: physical key → semitone above the octave's C. */
const MIDI_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const PANEL_HEIGHT_KEY = 'studio.panelHeight';
const LOCAL_VOLUME_KEY = 'studio.localVolume';

function readLocalVolume(): { level: number; muted: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_VOLUME_KEY) ?? 'null') as { level?: unknown; muted?: unknown } | null;
    const level = typeof v?.level === 'number' && v.level >= 0 && v.level <= 1 ? v.level : 1;
    return { level, muted: v?.muted === true };
  } catch { return { level: 1, muted: false }; }
}
const PANEL_MIN = 120;

/** Clip clipboard, shared across studios in this session. */
let clipboard: StudioClip[] | null = null;

const TIME_SIGS: [number, number][] = [[4, 4], [3, 4], [2, 4], [5, 4], [6, 8], [7, 8], [12, 8]];

function Avatar({ userId }: { userId: string }) {
  const member = useServerStore((s) => s.members.find((m) => m.userId === userId));
  const name = member?.user.displayName ?? 'Someone';
  const url = member?.user.avatarUrl;
  const color = colorForUser(userId);
  return (
    <div className="studio-avatar" style={{ borderColor: color }} title={name}>
      {url
        ? <img src={url.startsWith('http') ? url : `${getApiBase()}${url}`} alt={name} />
        : <span style={{ background: color }}>{name.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
}

export default function StudioView({ channelId, compact }: Props) {
  const join = useStudioStore((s) => s.join);
  const leave = useStudioStore((s) => s.leave);
  const doc = useStudioStore((s) => s.doc);
  const loading = useStudioStore((s) => s.loading);
  const error = useStudioStore((s) => s.error);
  const canEditPerm = useStudioStore((s) => s.canEdit);
  const users = useStudioStore((s) => s.users);
  const presence = useStudioStore((s) => s.presence);
  const assets = useStudioStore((s) => s.assets);
  const transport = useStudioStore((s) => s.transport);
  const followTransport = useStudioStore((s) => s.followTransport);
  const undoCount = useStudioStore((s) => s.undoStack.length);
  const redoCount = useStudioStore((s) => s.redoStack.length);
  const pendingCount = useStudioStore((s) => s.pending.length);
  const { edit, undo, redo, sendTransport, setFollowTransport, setLocalPresence } = useStudioStore.getState();
  const myId = useAuthStore((s) => s.user?.id);
  const channel = useServerStore((s) => s.channels.find((c) => c.id === channelId));

  const [engine, setEngine] = useState<StudioEngine | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  const [playhead, setPlayhead] = useState(0);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [peaksVersion, setPeaksVersion] = useState(0);
  const [pxPerBeat, setPxPerBeat] = useState(compact ? 16 : 24);
  const [snap, setSnap] = useState(1);
  const [metronome, setMetronome] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  /** Record-armed tracks (per user, like Ableton's arm buttons) */
  const [armedTrackIds, setArmedTrackIds] = useState<string[]>([]);
  const [midiRecording, setMidiRecording] = useState(false);
  const [recQuantize, setRecQuantize] = useState(() => {
    try { return Number(localStorage.getItem('studio.recQuantize')) || 0; } catch { return 0; }
  });
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelTab>('audio');
  // Phones start with the arrangement visible (the panel opens from its tabs).
  const [panelOpen, setPanelOpen] = useState(() => !compact && !window.matchMedia?.('(max-width: 700px)').matches);
  const [toolbarMore, setToolbarMore] = useState(false);
  const [panelHeight, setPanelHeight] = useState(() => {
    try { const v = Number(localStorage.getItem(PANEL_HEIGHT_KEY)); return v >= PANEL_MIN ? v : (compact ? 220 : 340); } catch { return compact ? 220 : 340; }
  });
  const [exporting, setExporting] = useState<string | null>(null);
  const [countIn, setCountIn] = useState(() => { try { return Number(localStorage.getItem(COUNT_IN_KEY)) || 0; } catch { return 0; } });
  const [countingIn, setCountingIn] = useState(false);
  const [followUserId, setFollowUserId] = useState<string | null>(null);
  /** Clip we chose to edit even though someone else has it open */
  const [lockOverride, setLockOverride] = useState<string | null>(null);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [confirmDeleteTrack, setConfirmDeleteTrack] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [autoArm, setAutoArm] = useState(false);
  const [midiKeys, setMidiKeys] = useState(false);
  const [midiOctave, setMidiOctave] = useState(4);
  const [midiVel, setMidiVel] = useState(100);
  /** Computer-keyboard key code → pitch it is holding */
  const heldKeys = useRef(new Map<string, number>());
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState(getRecordLatencyMs);
  /** What you hear, only on this device: never synced to collaborators or the export. */
  const [localVolume, setLocalVolume] = useState(readLocalVolume);
  const recorder = useStudioRecorder(engine);
  const input = useStudioInput({ engine, doc, armedTrackIds, selectedTrackId, recQuantize });

  const canManage = hasChannelPermission(channel?.permissions, Permission.ManageStudio);
  const editable = canEditPerm;
  const armedAudioId = doc ? armedTrackIds.find((id) => doc.tracks[id]?.kind === 'audio') ?? null : null;
  const [inputMenuOpen, setInputMenuOpen] = useState(false);
  const inputPrefs = useInputPrefs();
  // Open the input as soon as an audio track is armed, so the meter shows and
  // recording starts without a permission/device delay.
  const { live: liveInput, error: inputError } = useLiveInput(editable && (!!armedAudioId || inputMenuOpen));

  // ───────────── Lifecycle ─────────────

  // Narrow screens use a slimmer track header (phones, split windows).
  const [, setLayoutTick] = useState(0);
  useEffect(() => {
    const onResize = () => { if (syncHeaderWidth()) setLayoutTick((n) => n + 1); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [hasClipboard, setHasClipboard] = useState(() => !!clipboard?.length);

  useEffect(() => {
    void join(channelId);
    return () => leave();
  }, [channelId, join, leave]);

  useEffect(() => {
    const e = new StudioEngine();
    setEngine(e);
    return () => { e.dispose(); setIsPlaying(false); };
  }, []);

  useEffect(() => {
    if (engine && doc) engine.sync(doc);
  }, [engine, doc]);

  useEffect(() => {
    engine?.monitorInput(inputPrefs.monitor && armedAudioId ? armedAudioId : null, liveInput?.output ?? null);
  }, [engine, liveInput, inputPrefs.monitor, armedAudioId, doc?.tracks]);

  useEffect(() => {
    if (engine) engine.setMetronome(metronome);
  }, [engine, metronome]);

  useEffect(() => {
    const { level, muted } = localVolume;
    engine?.setMonitorVolume(muted || level <= 0 ? -Infinity : 20 * Math.log10(level));
    try { localStorage.setItem(LOCAL_VOLUME_KEY, JSON.stringify(localVolume)); } catch { /* ignore */ }
  }, [engine, localVolume]);

  // Decode every asset the arrangement uses; re-sync once each lands.
  useEffect(() => {
    return onAssetLoaded(() => {
      engine?.refresh();
      setPeaksVersion((v) => v + 1);
    });
  }, [engine]);

  useEffect(() => {
    if (!doc) return;
    const used = usedAssetIds(doc);
    for (const a of assets) {
      if (!used.has(a.id)) continue;
      if (isSoundFontAsset(a)) loadSoundFont(a.id, a.url).catch((e) => console.warn('[studio] soundfont load failed', a.name, e));
      else loadAsset(a.id, a.url).catch((e) => console.warn('[studio] asset load failed', a.name, e));
    }
  }, [doc, assets]);

  // Drop selection / editor state for things collaborators deleted.
  useEffect(() => {
    if (!doc) return;
    setSelection((sel) => (sel.every((id) => doc.clips[id]) ? sel : sel.filter((id) => doc.clips[id])));
    if (editingClipId && !doc.clips[editingClipId]) setEditingClipId(null);
    if (selectedTrackId && !doc.tracks[selectedTrackId]) setSelectedTrackId(null);
    if (armedTrackIds.some((id) => !doc.tracks[id])) setArmedTrackIds((ids) => ids.filter((id) => doc.tracks[id]));
  }, [doc, editingClipId, selectedTrackId, armedTrackIds]);

  useEffect(() => { setLocalPresence({ selection }); }, [selection, setLocalPresence]);
  const editingSince = useRef<number | null>(null);
  useEffect(() => {
    editingSince.current = editingClipId ? Date.now() + useStudioStore.getState().serverClockOffset : null;
    setLocalPresence({ editingClipId, editingSince: editingSince.current });
  }, [editingClipId, setLocalPresence]);

  // ───────────── Playhead + meters ─────────────

  useEffect(() => {
    if (!engine || !isPlaying) return;
    let raf = 0;
    let lastMeter = 0;
    let lastPresence = 0;
    const tick = (t: number) => {
      const pos = engine.getPositionBeats();
      setPlayhead(pos);
      if (t - lastMeter > 66) { lastMeter = t; setLevels(engine.getLevels().tracks); }
      if (t - lastPresence > 250) { lastPresence = t; setLocalPresence({ playheadBeats: pos }); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setLevels({});
      setLocalPresence({ playheadBeats: null });
    };
  }, [engine, isPlaying, setLocalPresence]);

  // The transport is the source of truth: if the UI ever disagrees with it
  // (an error mid-play, a remount), resync so Stop always reflects reality.
  useEffect(() => {
    if (!engine) return;
    const id = window.setInterval(() => {
      const actual = engine.isPlaying;
      if (actual === isPlayingRef.current) return;
      if (!actual) setPlayhead(engine.getPositionBeats());
      setIsPlaying(actual);
    }, 500);
    return () => window.clearInterval(id);
  }, [engine]);

  // ───────────── Transport ─────────────

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const play = useCallback(async (from: number, broadcast: boolean): Promise<boolean> => {
    if (!engine) return false;
    const started = await engine.play(from);
    if (!started || !mountedRef.current) return false;
    setNeedsUnlock(false);
    setIsPlaying(true);
    const st = useStudioStore.getState();
    if (broadcast && st.followTransport && st.canEdit) sendTransport(true, from);
    return true;
  }, [engine, sendTransport]);

  const stop = useCallback((broadcast: boolean) => {
    if (!engine) return;
    engine.stop();
    const pos = engine.getPositionBeats();
    setPlayhead(pos);
    setIsPlaying(false);
    const st = useStudioStore.getState();
    if (broadcast && st.followTransport && st.canEdit) sendTransport(false, pos);
  }, [engine, sendTransport]);

  const stopRecording = useCallback(async () => {
    // End MIDI take immediately so network upload of an audio take doesn't inflate its length.
    input.endTake();
    setMidiRecording(false);
    if (recorder.state === 'recording') await recorder.stop();
    else stop(true);
    setIsPlaying(false);
  }, [recorder, stop, input]);

  const togglePlay = useCallback(() => {
    if (countingIn) { engine?.cancelCountIn(); setCountingIn(false); return; }
    if (recorder.state === 'recording' || midiRecording) { void stopRecording(); return; }
    if (isPlaying) stop(true);
    else void play(playhead, true);
  }, [countingIn, engine, isPlaying, play, stop, playhead, recorder, midiRecording, stopRecording]);

  const seek = useCallback((beats: number) => {
    setPlayhead(beats);
    if (!engine) return;
    if (isPlaying) {
      void play(beats, true);
    } else {
      engine.seek(beats);
      const st = useStudioStore.getState();
      if (st.followTransport && st.canEdit) sendTransport(false, beats);
    }
  }, [engine, isPlaying, play, sendTransport]);

  // Follow collaborators' transport (when sync is on).
  useEffect(() => {
    if (!engine || !followTransport || !transport.userId || transport.userId === myId) return;
    const meta = useStudioStore.getState().doc?.meta;
    if (!transport.isPlaying) {
      if (engine.isPlaying) engine.stop();
      engine.seek(transport.positionBeats);
      setIsPlaying(false);
      setPlayhead(transport.positionBeats);
      return;
    }
    const offset = useStudioStore.getState().serverClockOffset;
    const elapsed = Math.max(0, (Date.now() + offset - transport.serverTimeMs) / 1000);
    const doc0 = useStudioStore.getState().doc;
    const map = doc0 ? tempoMap(doc0) : null;
    let pos = map ? secToBeat(map, beatToSec(map, transport.positionBeats) + elapsed) : transport.positionBeats;
    if (meta?.loopEnabled && meta.loopEnd > meta.loopStart && pos >= meta.loopEnd) {
      pos = meta.loopStart + ((pos - meta.loopStart) % (meta.loopEnd - meta.loopStart));
    }
    if (Tone.getContext().state !== 'running') {
      // Browsers need a gesture before audio can start.
      setNeedsUnlock(true);
      setPlayhead(pos);
      return;
    }
    void play(pos, false);
  }, [engine, transport, followTransport, myId, play]);

  const unlockAndFollow = async () => {
    await Tone.start();
    setNeedsUnlock(false);
    const t = useStudioStore.getState().transport;
    if (t.isPlaying) {
      const offset = useStudioStore.getState().serverClockOffset;
      const d = useStudioStore.getState().doc;
      const elapsed = Math.max(0, (Date.now() + offset - t.serverTimeMs) / 1000);
      const map = d ? tempoMap(d) : null;
      let pos = map ? secToBeat(map, beatToSec(map, t.positionBeats) + elapsed) : t.positionBeats;
      const meta = d?.meta;
      if (meta?.loopEnabled && meta.loopEnd > meta.loopStart && pos >= meta.loopEnd) {
        pos = meta.loopStart + ((pos - meta.loopStart) % (meta.loopEnd - meta.loopStart));
      }
      void play(pos, false);
    }
  };

  /** Arrangement record: MIDI onto armed instrument tracks (or the selected one), audio onto an armed audio track. */
  const toggleRecord = async () => {
    if (countingIn) { engine?.cancelCountIn(); setCountingIn(false); return; }
    if (recorder.state === 'recording' || midiRecording) { await stopRecording(); return; }
    if (!doc) return;
    const audioTrack = armedTrackIds.find((id) => doc.tracks[id]?.kind === 'audio');
    const midiTracks = input.targets();
    if (!audioTrack && !midiTracks.length) {
      useToastStore.getState().addToast('Arm a track (●) to record onto it.', 'info');
      return;
    }
    if (isPlaying) stop(true);
    if (countIn > 0 && engine) {
      // Clicks only you hear; recording starts on the downbeat after.
      setCountingIn(true);
      let end: number | null = null;
      try { end = await engine.countIn(playhead, countIn); } finally { if (mountedRef.current) setCountingIn(false); }
      if (end == null || !mountedRef.current) return;
    }
    input.beginTake(midiTracks, playhead);
    setMidiRecording(midiTracks.length > 0);
    if (audioTrack) {
      const ok = await recorder.start(audioTrack, playhead, liveInput?.recordStream);
      if (!ok) {
        input.endTake();
        if (mountedRef.current) setMidiRecording(false);
        return;
      }
      if (mountedRef.current) setIsPlaying(true);
    } else {
      const ok = await play(playhead, true);
      if (!ok) {
        input.endTake();
        if (mountedRef.current) setMidiRecording(false);
      }
    }
  };

  const armTrack = (id: string, additive: boolean) => {
    setArmedTrackIds((ids) => (ids.includes(id)
      ? ids.filter((x) => x !== id)
      : additive ? [...ids, id] : [id]));
  };

  // ───────────── Editing helpers ─────────────

  const trackIds = useMemo(() => (doc ? sortedTrackIds(doc) : []), [doc]);
  const grid = doc ? snapSize(snap, doc.meta) : 1;

  const addTrack = (kind: StudioTrack['kind'], instrument?: 'synth' | 'drums' | 'bass' | 'sampler' | 'soundfont', params?: StudioParams, name?: string) => {
    if (!doc) return;
    if (Object.keys(doc.tracks).length >= MAX_TRACKS) { useToastStore.getState().addToast(`A project can have up to ${MAX_TRACKS} tracks.`, 'info'); return; }
    const id = studioId();
    const count = Object.values(doc.tracks).filter((t) => t.kind === kind).length + 1;
    const label = kind === 'audio' ? 'Audio' : kind === 'group' ? 'Group' : instrument === 'drums' ? 'Drums' : instrument === 'bass' ? 'Bass' : instrument === 'sampler' ? 'Sampler' : instrument === 'soundfont' ? 'SoundFont' : 'Synth';
    const trackName = (name ?? (kind === 'return' ? `${String.fromCharCode(64 + Math.min(26, count))}-Return` : `${label} ${count}`)).slice(0, 40);
    const ops: StudioOp[] = [];
    let order = nextTrackOrder(doc);
    // A new group takes the selected track (and sits where it was).
    const sel = selectedTrackId ? doc.tracks[selectedTrackId] : undefined;
    if (kind === 'group' && sel && sel.kind !== 'return') {
      order = sel.order - 0.5;
      ops.push({ t: 'set', path: ['tracks', selectedTrackId!, 'output'], value: id });
    }
    // Returns start with a 100%-wet reverb (A) or delay (B), ready to send to.
    const fxType = kind === 'return' ? (count % 2 === 0 ? 'delay' : 'reverb') : null;
    const effects = fxType ? [{ id: studioId(), type: fxType, params: { ...Object.fromEntries(Object.entries(EFFECT_DEFS[fxType].defaults()).filter(([, v]) => typeof v !== 'object')), mix: 100 } }] : undefined;
    ops.unshift({
      t: 'set', path: ['tracks', id], value: {
        name: trackName, kind, order, color: kind === 'return' ? '#99aab5' : nextTrackColor(doc),
        volume: kind === 'instrument' ? -6 : 0, pan: 0, mute: false, solo: false,
        ...(kind === 'instrument' ? { instrument: { type: instrument ?? 'synth', ...(params ? { params } : {}) } } : {}),
        ...(effects ? { effects } : {}),
      },
    });
    edit(ops);
    setSelectedTrackId(id);
  };

  // ───────────── MIDI import ─────────────

  const [midiImport, setMidiImport] = useState<{ name: string; info: MidiFileInfo } | null>(null);
  const midiInputRef = useRef<HTMLInputElement>(null);

  const openMidiFile = async (file: File) => {
    if (!editable) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('That MIDI file is too large (8 MB max).');
      const info = parseMidi(await file.arrayBuffer());
      if (!info.parts.length) throw new Error('No notes found in that MIDI file.');
      setMidiImport({ name: file.name, info });
    } catch (e) {
      useToastStore.getState().addToast(e instanceof Error ? e.message : 'Could not read that MIDI file.', 'error');
    }
  };

  const runMidiImport = async (keys: string[], opts: { tempo: boolean; timeSig: boolean; atStart: boolean; soundfontId?: string }) => {
    if (!doc || !midiImport) return;
    const { info } = midiImport;
    const parts = info.parts.filter((p) => keys.includes(p.key));
    let soundfont: { assetId: string; sf: NonNullable<ReturnType<typeof getSoundFont>> } | undefined;
    if (opts.soundfontId) {
      const sfAsset = useStudioStore.getState().assets.find((a) => a.id === opts.soundfontId);
      if (sfAsset) {
        try {
          const sf = getSoundFont(sfAsset.id) ?? await loadSoundFont(sfAsset.id, sfAsset.url);
          soundfont = { assetId: sfAsset.id, sf };
        } catch {
          useToastStore.getState().addToast(`Couldn't load SoundFont ${sfAsset.name}; importing with built-in synths.`, 'error');
        }
      }
    }
    const latestDoc = useStudioStore.getState().doc ?? doc;
    const meta = { ...latestDoc.meta, ...(opts.timeSig && info.timeSig ? { timeSigNum: info.timeSig.num, timeSigDen: info.timeSig.den } : {}) };
    const bar = barBeats(meta);
    const at = opts.atStart ? 0 : opts.timeSig && info.timeSig ? Math.floor(playhead / bar) * bar : barFloor(latestDoc, playhead);
    const { ops, trackIds: added } = midiImportOps(latestDoc, parts, at, {
      bpm: opts.tempo && info.bpm ? info.bpm : undefined,
      timeSig: opts.timeSig && info.timeSig ? info.timeSig : undefined,
      soundfont,
    });
    // Big files go out in several messages (each is its own undo step).
    for (const batch of batchOps(ops)) edit(batch);
    setMidiImport(null);
    if (added[0]) setSelectedTrackId(added[0]);
    const n = parts.reduce((a, p) => a + (soundfont && p.rawNotes?.length ? p.rawNotes.length : p.notes.length), 0);
    useToastStore.getState().addToast(`Imported ${parts.length} track${parts.length === 1 ? '' : 's'} (${n} notes).`, 'success');
  };

  const onViewDragOver = (e: React.DragEvent) => {
    if (editable && e.dataTransfer.types.includes('Files')) e.preventDefault();
  };
  const onViewDrop = (e: React.DragEvent) => {
    if (!editable) return;
    const files = Array.from(e.dataTransfer.files);
    const midi = files.find(isMidiFile);
    if (midi) {
      e.preventDefault();
      void openMidiFile(midi);
      return;
    }
    const sfFiles = files.filter(isSoundFontFile);
    if (sfFiles.length) {
      e.preventDefault();
      void uploadAudioFiles(sfFiles).then((added) => {
        if (added.length) {
          useToastStore.getState().addToast(
            `Uploaded SoundFont ${added.map((a) => a.name).join(', ')} — select SoundFont on a track or import a MIDI file.`,
            'success',
          );
        }
      });
    }
  };

  const deleteSelected = useCallback(() => {
    if (!selection.length) return;
    edit(selection.map((id) => ({ t: 'del' as const, path: ['clips', id] })));
    setSelection([]);
  }, [selection, edit]);

  const duplicateSelected = useCallback(() => {
    if (!doc || !selection.length) return;
    const clips = selection.map((id) => doc.clips[id]).filter(Boolean);
    const minStart = Math.min(...clips.map((c) => c.start));
    const maxEnd = Math.max(...clips.map((c) => c.start + c.length));
    const shift = maxEnd - minStart;
    const ids: string[] = [];
    const ops: StudioOp[] = clips.map((c) => {
      const id = studioId();
      ids.push(id);
      return { t: 'set', path: ['clips', id], value: { ...c, start: c.start + shift } };
    });
    edit(ops);
    setSelection(ids);
  }, [doc, selection, edit]);

  const splitAtPlayhead = useCallback(() => {
    if (!doc) return;
    const p = playhead;
    const targets = (selection.length ? selection : Object.keys(doc.clips)).filter((id) => {
      const c = doc.clips[id];
      return c && c.start < p && c.start + c.length > p && (selection.length || c.trackId === selectedTrackId);
    });
    if (!targets.length) return;
    const ops: StudioOp[] = [];
    const newIds: string[] = [];
    for (const id of targets) {
      const c = doc.clips[id];
      const leftLen = p - c.start;
      const left = sliceClip(doc, c, 0, leftLen);
      const right = sliceClip(doc, c, leftLen, c.length);
      const rid = studioId();
      newIds.push(rid);
      ops.push({ t: 'set', path: ['clips', id], value: left }, { t: 'set', path: ['clips', rid], value: right });
    }
    edit(ops);
    setSelection(newIds);
  }, [doc, playhead, selection, selectedTrackId, edit]);

  const addAssetAtPlayhead = (asset: StudioAsset) => {
    if (!doc) return;
    let trackId = selectedTrackId && doc.tracks[selectedTrackId]?.kind === 'audio' ? selectedTrackId : trackIds.find((id) => doc.tracks[id].kind === 'audio');
    const ops: StudioOp[] = [];
    if (!trackId) {
      trackId = studioId();
      ops.push({ t: 'set', path: ['tracks', trackId], value: { name: 'Audio 1', kind: 'audio', order: nextTrackOrder(doc), color: nextTrackColor(doc), volume: 0, pan: 0, mute: false, solo: false } });
    }
    ops.push(audioClipOp(asset, trackId, playhead, doc));
    edit(ops);
  };

  const commitBpm = () => {
    if (bpmDraft == null || !doc) return;
    const v = Math.round(Number(bpmDraft) * 10) / 10;
    setBpmDraft(null);
    if (Number.isFinite(v) && v >= 20 && v <= 400 && v !== doc.meta.bpm) edit([{ t: 'set', path: ['meta', 'bpm'], value: v }]);
  };

  const runExport = async (what: 'wav' | 'stems' | 'midi') => {
    if (!doc || exporting) return;
    const base = channel?.name ?? 'studio';
    if (what === 'midi') {
      if (!Object.values(doc.tracks).some((t) => t.kind === 'instrument')) { useToastStore.getState().addToast('No instrument tracks to export.', 'info'); return; }
      download(exportMidi(doc), `${base}.mid`);
      return;
    }
    setExporting(what === 'wav' ? 'Rendering…' : 'Stems…');
    try {
      if (what === 'wav') download(await renderProjectToWav(doc, assets), `${base}.wav`);
      else download(await renderStemsZip(doc, assets, (done, total) => setExporting(`Stems ${done}/${total}…`)), `${base} stems.zip`);
    } catch (e) {
      console.error('[studio] export failed', e);
      useToastStore.getState().addToast('Export failed.', 'error');
    } finally {
      setExporting(null);
    }
  };

  const openClip = (id: string) => {
    setEditingClipId(id);
    setPanel('editor');
    setPanelOpen(true);
  };

  // ───────────── Track / clip commands (keyboard) ─────────────

  const duplicateTrack = (trackId: string) => {
    if (!doc?.tracks[trackId]) return;
    const src = doc.tracks[trackId];
    const nextOrder = trackIds.map((id) => doc.tracks[id].order).filter((o) => o > src.order).sort((x, y) => x - y)[0];
    const id = studioId();
    const ops: StudioOp[] = [{
      t: 'set', path: ['tracks', id],
      value: { ...src, name: `${src.name} copy`.slice(0, 40), order: nextOrder === undefined ? src.order + 1 : (src.order + nextOrder) / 2 },
    }];
    for (const c of Object.values(doc.clips)) {
      if (c.trackId === trackId) ops.push({ t: 'set', path: ['clips', studioId()], value: { ...c, trackId: id } });
    }
    edit(ops);
    setSelectedTrackId(id);
  };

  const copySelection = () => {
    if (!doc || !selection.length) return false;
    clipboard = selection.map((id) => doc.clips[id]).filter(Boolean);
    setHasClipboard(clipboard.length > 0);
    return clipboard.length > 0;
  };

  const paste = () => {
    if (!doc || !clipboard?.length) return;
    const anchor = Math.min(...clipboard.map((c) => c.start));
    const singleTrack = clipboard.every((c) => c.trackId === clipboard![0].trackId);
    const sel = selectedTrackId ? doc.tracks[selectedTrackId] : undefined;
    const ops: StudioOp[] = [];
    const ids: string[] = [];
    let end = playhead;
    for (const c of clipboard) {
      let trackId = c.trackId;
      // A single-track clipboard follows the selected track if the kinds match.
      if (singleTrack && sel && clipFitsTrack(c.kind, sel.kind)) trackId = selectedTrackId!;
      const t = doc.tracks[trackId];
      if (!t || !clipFitsTrack(c.kind, t.kind)) continue;
      const id = studioId();
      const start = playhead + (c.start - anchor);
      ids.push(id);
      end = Math.max(end, start + c.length);
      ops.push({ t: 'set', path: ['clips', id], value: { ...c, trackId, start } });
    }
    if (!ops.length) return;
    edit(ops);
    setSelection(ids);
    // Like an insert marker: repeated pastes chain end to end.
    setPlayhead(end);
    engine?.seek(end);
  };

  const nudgeSelection = (delta: number) => {
    if (!doc || !selection.length) return;
    const clips = selection.map((id) => [id, doc.clips[id]] as const).filter(([, c]) => c);
    const minStart = Math.min(...clips.map(([, c]) => c.start));
    const d = Math.max(delta, -minStart);
    if (d === 0) return;
    edit(clips.map(([id, c]) => ({ t: 'set' as const, path: ['clips', id, 'start'], value: c.start + d })));
  };

  const selectAllClips = () => {
    if (!doc) return;
    const onTrack = selectedTrackId ? Object.keys(doc.clips).filter((id) => doc.clips[id].trackId === selectedTrackId) : [];
    setSelection(onTrack.length ? onTrack : Object.keys(doc.clips));
  };

  const moveTrackSelection = (dir: 1 | -1) => {
    if (!trackIds.length) return;
    const i = selectedTrackId ? trackIds.indexOf(selectedTrackId) : -1;
    const next = trackIds[Math.max(0, Math.min(trackIds.length - 1, i < 0 ? 0 : i + dir))];
    setSelectedTrackId(next);
    setSelection([]);
  };

  const toggleTrackField = (field: 'mute' | 'solo') => {
    const t = selectedTrackId ? doc?.tracks[selectedTrackId] : undefined;
    if (t) edit([{ t: 'set', path: ['tracks', selectedTrackId!, field], value: !t[field] }]);
  };

  // Automation recording reads the live playhead; only records while armed and playing.
  useEffect(() => {
    setAutomationContext({ armed: autoArm, beat: () => (engine?.isPlaying ? engine.getPositionBeats() : null) });
    return () => setAutomationContext({ armed: false, beat: () => null });
  }, [autoArm, engine]);

  // ───────────── Computer MIDI keyboard ─────────────

  /** Where live notes go: armed instrument tracks, else the selected one (auto-arm). */
  const inputTargetIds = inputTargets(doc, armedTrackIds, selectedTrackId);
  const inputLabel = inputTargetIds.length > 1 ? `${inputTargetIds.length} tracks` : inputTargetIds[0] ? doc?.tracks[inputTargetIds[0]].name : null;

  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; });

  const releaseHeldNotes = useCallback(() => {
    heldKeys.current.clear();
    inputRef.current.releaseAll();
  }, []);

  const toggleMidiKeys = () => {
    if (midiKeys) releaseHeldNotes();
    else if (!inputTargetIds.length) useToastStore.getState().addToast('Select or arm an instrument track to play it.', 'info');
    setMidiKeys(!midiKeys);
  };

  useEffect(() => {
    const onUp = (e: KeyboardEvent) => {
      const pitch = heldKeys.current.get(e.code);
      if (pitch === undefined) return;
      heldKeys.current.delete(e.code);
      inputRef.current.noteOff(pitch);
    };
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', releaseHeldNotes);
    return () => {
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', releaseHeldNotes);
      releaseHeldNotes();
    };
  }, [releaseHeldNotes]);

  // Hardware MIDI → the same input router.
  useEffect(() => {
    void restoreMidi();
    setMidiHandler((e) => {
      const r = inputRef.current;
      switch (e.type) {
        case 'on': r.noteOn(e.pitch, e.vel); break;
        case 'off': r.noteOff(e.pitch); break;
        case 'sustain': r.sustain(e.down); break;
        case 'bend': r.pitchBend(e.semis); break;
        case 'modwheel': r.modWheel(e.value); break;
      }
    });
    return () => setMidiHandler(null);
  }, []);

  // ───────────── Keyboard ─────────────

  const handleKey = (e: KeyboardEvent) => {
    if (keyBelongsToTarget(e) || document.querySelector('.modal-overlay')) return;
    if (!doc) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    const bar = barBeats(doc.meta);
    const step = e.shiftKey ? bar : (grid > 0 ? grid : 1);

    // Computer MIDI keyboard (Ctrl+M toggles; Ctrl even on Mac, where Cmd+M minimises)
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyM') { done(); toggleMidiKeys(); return; }
    if (midiKeys && !mod && !e.altKey) {
      if (e.code in MIDI_KEYS) {
        done();
        if (e.repeat || heldKeys.current.has(e.code)) return;
        const pitch = Math.min(127, (midiOctave + 1) * 12 + MIDI_KEYS[e.code]);
        heldKeys.current.set(e.code, pitch);
        input.noteOn(pitch, midiVel / 127);
        return;
      }
      if (e.code === 'KeyZ') { done(); setMidiOctave((o) => Math.max(0, o - 1)); return; }
      if (e.code === 'KeyX') { done(); setMidiOctave((o) => Math.min(8, o + 1)); return; }
      if (e.code === 'KeyC') { done(); setMidiVel((v) => Math.max(1, v - 20)); return; }
      if (e.code === 'KeyV') { done(); setMidiVel((v) => Math.min(127, v + 20)); return; }
      if (key === 'Escape') { done(); toggleMidiKeys(); return; }
    }

    // Available to everyone
    if (e.code === 'Space') { done(); togglePlay(); return; }
    if (key === '?' || key === 'F1') { done(); setShowShortcuts(true); return; }
    if (key === 'Enter' && !mod) { done(); seek(0); return; }
    if (!mod && !e.altKey && (key === '=' || key === '+')) { done(); setPxPerBeat((z) => Math.min(200, z * 1.25)); return; }
    if (!mod && !e.altKey && key === '-') { done(); setPxPerBeat((z) => Math.max(4, z / 1.25)); return; }
    if (key === 'Tab' && e.shiftKey) { done(); setPanelOpen((o) => !o); return; }
    if (key === 'c' && !mod && !e.altKey) { done(); setMetronome((m) => !m); return; }
    if (key === 'ArrowUp' && !mod) { done(); moveTrackSelection(-1); return; }
    if (key === 'ArrowDown' && !mod) { done(); moveTrackSelection(1); return; }
    if (key === 'e' && !mod && selection.length === 1 && doc.clips[selection[0]]?.kind === 'midi') { done(); openClip(selection[0]); return; }
    if (key === 'Escape') { setSelection([]); return; }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && !mod && !(editable && selection.length)) {
      done();
      seek(Math.max(0, playhead + (key === 'ArrowLeft' ? -step : step)));
      return;
    }
    if (mod && key === 'c') { if (copySelection()) done(); return; }
    if (mod && key === 'a') { done(); selectAllClips(); return; }

    if (!editable) return;
    if (mod && key === 'z') { done(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y') { done(); redo(); return; }
    if (mod && key === 'd') {
      done();
      if (selection.length) duplicateSelected();
      else if (selectedTrackId) duplicateTrack(selectedTrackId);
      return;
    }
    if (mod && key === 'x') { if (copySelection()) { done(); deleteSelected(); } return; }
    if (mod && key === 'v') { done(); paste(); return; }
    if (mod && key === 'e') { done(); splitAtPlayhead(); return; }
    if (e.altKey && !mod && e.code === 'KeyA') { done(); addTrack('audio'); return; }
    if (e.altKey && !mod && e.code === 'KeyI') { done(); addTrack('instrument'); return; }
    if (mod || e.altKey) return;
    if (key === 'Delete' || key === 'Backspace') {
      done();
      if (selection.length) deleteSelected();
      else if (selectedTrackId) setConfirmDeleteTrack(selectedTrackId);
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') { done(); nudgeSelection(key === 'ArrowLeft' ? -step : step); return; }
    if (key === 's' && e.shiftKey) { done(); toggleTrackField('solo'); return; }
    if (key === 's') { done(); splitAtPlayhead(); return; }
    if (key === 'm') { done(); toggleTrackField('mute'); return; }
    if (key === 'l') { done(); edit([{ t: 'set', path: ['meta', 'loopEnabled'], value: !doc.meta.loopEnabled }]); return; }
    if (key === 'r' && selectedTrackId) { done(); armTrack(selectedTrackId, false); return; }
    if (key === 'F9' && e.shiftKey) { done(); setAutoArm((a) => !a); return; }
    if (key === 'F9') { done(); void toggleRecord(); return; }
  };

  // Window listener reads the latest handler without re-subscribing every render.
  const keyHandlerRef = useRef(handleKey);
  useEffect(() => { keyHandlerRef.current = handleKey; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ───────────── Render ─────────────

  if (error) {
    return (
      <div className="studio-view">
        <div className="studio-message">
          <span>{error}</span>
          <button className="studio-btn primary" onClick={() => void useStudioStore.getState().resync()}>Retry</button>
        </div>
      </div>
    );
  }
  if (loading || !doc) return <div className="studio-view"><div className="studio-message">Loading studio…</div></div>;

  const meta = doc.meta;
  const markerEnd = Math.max(0, ...Object.values(doc.markers ?? {}).map((m) => m.beat), ...Object.values(doc.tempo ?? {}).map((t) => t.beat));
  const totalBeats = Math.max(arrangementEnd(doc) + barBeats(meta) * 8, markerEnd + barBeats(meta) * 8, barBeats(meta) * 32);
  const assetIds = new Set(assets.map((a) => a.id));
  const following = followUserId && users.includes(followUserId) ? followUserId : null;
  // Soft lock: whoever opened the clip first holds it; later openers see a banner.
  const editLockedBy = editingClipId ? Object.entries(presence).find(([uid, p]) => uid !== myId && p.editingClipId === editingClipId
    && (p.editingSince ?? 0) <= (editingSince.current ?? Infinity))?.[0] ?? null : null;
  const rollEditable = editable && (!editLockedBy || lockOverride === editingClipId);
  const editingClip = editingClipId ? doc.clips[editingClipId] : undefined;
  const editingTrack = editingClip ? doc.tracks[editingClip.trackId] : undefined;
  const inspectedTrack = selectedTrackId ? doc.tracks[selectedTrackId] : undefined;
  const others = users.filter((u) => u !== myId);
  const recording = recorder.state === 'recording' || midiRecording;

  return (
    <div
      className={`studio-view${compact ? ' compact' : ''}`}
      onChange={(e) => { if (e.target instanceof HTMLSelectElement) e.target.blur(); }}
      onDragOver={onViewDragOver}
      onDrop={onViewDrop}
    >
      <div className={`studio-toolbar${toolbarMore ? ' more' : ''}`}>
        <div className="studio-toolbar-group">
          <button className="studio-btn icon" onClick={() => seek(0)} title="Return to start (Enter)">⏮</button>
          <button className={`studio-btn icon primary${isPlaying && !recording ? ' on' : ''}`} onClick={togglePlay} title="Play / Stop (Space)">
            {isPlaying ? '■' : '▶'}
          </button>
          {editable && (
            <button
              className={`studio-btn icon record${recording ? ' on' : ''}`}
              onClick={() => void toggleRecord()}
              disabled={recorder.state === 'uploading'}
              title={armedTrackIds.length || inputTargetIds.length ? 'Record (F9): MIDI onto armed instrument tracks, audio onto an armed audio track' : 'Arm a track (●) to record'}
            >
              {recorder.state === 'uploading' ? '…' : '⏺'}
            </button>
          )}
          {editable && (
            <button
              className={`studio-btn auto-arm tb-extra${autoArm ? ' on' : ''}`}
              onClick={() => setAutoArm((a) => !a)}
              title="Automation arm (Shift+F9): while playing, moving volume, pan, effect or synth controls records automation"
            >● Auto</button>
          )}
          {editable && (
            <select
              className={`studio-select small tb-extra${countIn ? ' on' : ''}`}
              value={countIn}
              title="Count-in before recording (only you hear it)"
              onChange={(e) => { const v = Number(e.target.value); setCountIn(v); try { localStorage.setItem(COUNT_IN_KEY, String(v)); } catch { /* ignore */ } }}
            >
              <option value={0}>No count-in</option>
              <option value={1}>Count-in 1 bar</option>
              <option value={2}>Count-in 2 bars</option>
            </select>
          )}
          <div className={`studio-position${countingIn ? ' counting' : ''}`} title="Bar.Beat.Sixteenth">{countingIn ? 'Count-in…' : formatPosition(playhead, doc)}</div>
        </div>

        <div className="studio-toolbar-group">
          <label className="studio-field" title="Tempo">
            <input
              className="studio-bpm"
              type="number"
              min={20} max={400} step={0.1}
              disabled={!editable}
              value={bpmDraft ?? String(meta.bpm)}
              onChange={(e) => setBpmDraft(e.target.value)}
              onBlur={commitBpm}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setBpmDraft(null); }}
            />
            <span>BPM</span>
          </label>
          <select
            className="studio-select"
            title="Time signature"
            disabled={!editable}
            value={`${meta.timeSigNum}/${meta.timeSigDen}`}
            onChange={(e) => {
              const [n, d] = e.target.value.split('/').map(Number);
              edit([{ t: 'set', path: ['meta', 'timeSigNum'], value: n }, { t: 'set', path: ['meta', 'timeSigDen'], value: d }]);
            }}
          >
            {TIME_SIGS.map(([n, d]) => <option key={`${n}/${d}`} value={`${n}/${d}`}>{n}/{d}</option>)}
          </select>
          <button
            className={`studio-btn${meta.loopEnabled ? ' on' : ''}`}
            disabled={!editable}
            onClick={() => edit([{ t: 'set', path: ['meta', 'loopEnabled'], value: !meta.loopEnabled }])}
            title="Loop (drag on the ruler to set the range)"
          >⟳ Loop</button>
          <button className={`studio-btn${metronome ? ' on' : ''}`} onClick={() => setMetronome((m) => !m)} title="Metronome (only you hear it)">♩ Click</button>
        </div>

        <div className="studio-toolbar-group">
          <select className="studio-select" value={snap} onChange={(e) => setSnap(Number(e.target.value))} title="Snap to grid">
            {SNAP_OPTIONS.map((o) => <option key={o.value} value={o.value}>Snap: {o.label}</option>)}
          </select>
          <button className="studio-btn icon tb-extra" onClick={() => setPxPerBeat((z) => Math.max(4, z / 1.25))} title="Zoom out (or pinch)">−</button>
          <button className="studio-btn icon tb-extra" onClick={() => setPxPerBeat((z) => Math.min(200, z * 1.25))} title="Zoom in (or pinch)">+</button>
          <button className="studio-btn icon studio-more-btn" onClick={() => setToolbarMore((m) => !m)} title="More controls">{toolbarMore ? '✕' : '⋯'}</button>
        </div>

        {editable && (
          <div className="studio-toolbar-group">
            <button className="studio-btn icon" disabled={!undoCount} onClick={undo} title="Undo your last edit (Ctrl+Z)">↶</button>
            <button className="studio-btn icon" disabled={!redoCount} onClick={redo} title="Redo (Ctrl+Shift+Z)">↷</button>
            <select
              className="studio-select"
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'midi') midiInputRef.current?.click();
                else if (v === 'audio' || v === 'return' || v === 'group') addTrack(v);
                else if (v) addTrack('instrument', v as 'synth' | 'drums' | 'bass' | 'sampler');
              }}
              disabled={trackIds.length >= MAX_TRACKS}
              title="Add track"
            >
              <option value="">＋ Track</option>
              <option value="audio">Audio</option>
              <option value="synth">Synth</option>
              <option value="drums">Drums</option>
              <option value="bass">Bass</option>
              <option value="sampler">Sampler</option>
              <option value="return">Return (send effects)</option>
              <option value="group">Group{selectedTrackId && doc.tracks[selectedTrackId]?.kind !== 'return' ? ` (with “${doc.tracks[selectedTrackId].name}”)` : ''}</option>
              <option value="midi">Import MIDI file…</option>
            </select>
            {(selection.length > 0 || hasClipboard) && (
              <span className="studio-clip-actions" title="Clip actions (also on the keyboard)">
                {selection.length > 0 && <>
                  <button className="studio-btn icon" onClick={splitAtPlayhead} title="Split at playhead (S / Ctrl+E)">✂</button>
                  <button className="studio-btn icon" onClick={duplicateSelected} title="Duplicate (Ctrl+D)">⧉</button>
                  <button className="studio-btn icon" onClick={() => copySelection()} title="Copy (Ctrl+C)">⎘</button>
                  <button className="studio-btn icon" onClick={deleteSelected} title="Delete (Delete)">🗑</button>
                </>}
                {hasClipboard && <button className="studio-btn icon" onClick={paste} title="Paste at playhead (Ctrl+V)">📋</button>}
              </span>
            )}
            <input
              ref={midiInputRef} type="file" accept=".mid,.midi,.smf,.kar,audio/midi" hidden
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void openMidiFile(f); }}
            />
          </div>
        )}

        <div className="studio-spacer" />

        <div className="studio-toolbar-group">
          <div className="studio-local-volume tb-extra" title="Your volume: only changes what you hear">
            <button
              className={`studio-btn icon small${localVolume.muted ? ' on' : ''}`}
              onClick={() => setLocalVolume((v) => ({ ...v, muted: !v.muted }))}
              title={localVolume.muted ? 'Unmute (only you)' : 'Mute (only you)'}
            >
              {localVolume.muted || localVolume.level <= 0 ? '🔇' : localVolume.level < 0.5 ? '🔉' : '🔊'}
            </button>
            <input
              type="range" min={0} max={1} step={0.01}
              value={localVolume.muted ? 0 : localVolume.level}
              onChange={(e) => setLocalVolume({ level: Number(e.target.value), muted: false })}
              onDoubleClick={() => setLocalVolume({ level: 1, muted: false })}
              aria-label="Your listening volume"
            />
          </div>
          <label className="studio-check" title="Share play/stop with everyone who has sync on, and follow theirs">
            <input type="checkbox" checked={followTransport} onChange={(e) => setFollowTransport(e.target.checked)} />
            Sync playback
          </label>
          {editable && (
            <span className="tb-extra"><StudioInputMenu
              open={inputMenuOpen}
              onOpenChange={setInputMenuOpen}
              live={liveInput}
              error={inputError}
              armedLabel={armedAudioId ? doc?.tracks[armedAudioId]?.name ?? null : null}
              latencyMs={latencyMs}
              onLatency={(v) => { setLatencyMs(v); setRecordLatencyMs(v); }}
            /></span>
          )}
          <span className="tb-extra"><StudioMidiMenu
            targetLabel={inputLabel ?? null}
            recQuantize={recQuantize}
            onRecQuantize={(q) => { setRecQuantize(q); try { localStorage.setItem('studio.recQuantize', String(q)); } catch { /* ignore */ } }}
          /></span>
          <button
            className={`studio-btn tb-extra${midiKeys ? ' on' : ''}`}
            onClick={toggleMidiKeys}
            title="Play notes with your computer keyboard (Ctrl+M). A–L = white keys, W E T Y U O P = black keys, Z/X = octave, C/V = velocity"
          >
            🎹 {midiKeys ? `${NOTE_NAMES[0]}${midiOctave} · ${midiVel}${inputLabel ? ` → ${inputLabel}` : ''}` : 'Keys'}
          </button>
          <button className="studio-btn icon tb-extra" onClick={() => setShowShortcuts(true)} title="Keyboard shortcuts (?)">⌨ ?</button>
          <select
            className="studio-select"
            value=""
            disabled={!!exporting}
            title="Export"
            onChange={(e) => { const v = e.target.value as 'wav' | 'stems' | 'midi' | ''; if (v) void runExport(v); }}
          >
            <option value="">{exporting ?? '⤓ Export'}</option>
            <option value="wav">Mix (WAV)</option>
            <option value="stems">Stems (ZIP of WAVs)</option>
            <option value="midi">MIDI (.mid)</option>
          </select>
          <div className="studio-avatars" title={`${users.length} in studio — click someone to follow their view`}>
            {myId && users.includes(myId) && <Avatar userId={myId} />}
            {others.slice(0, 6).map((u) => (
              <button
                key={u}
                className={`studio-avatar-btn${following === u ? ' following' : ''}`}
                onClick={() => setFollowUserId((f) => (f === u ? null : u))}
                title={following === u ? `Stop following ${memberName(u)}` : `Follow ${memberName(u)}'s view`}
              >
                <Avatar userId={u} />
              </button>
            ))}
            {others.length > 6 && <div className="studio-avatar more">+{others.length - 6}</div>}
          </div>
          <span className={`studio-sync-dot${pendingCount ? ' pending' : ''}`} title={pendingCount ? 'Saving edits…' : 'All edits synced'} />
        </div>
      </div>

      {!canEditPerm && <div className="studio-banner">You can listen to this studio, but you don't have permission to edit it.</div>}
      {following && (
        <button className="studio-banner action" onClick={() => setFollowUserId(null)} style={{ borderColor: colorForUser(following) }}>
          👁 Following {memberName(following)}'s view{presence[following]?.editingClipId ? ' (they have a clip open in the piano roll)' : ''} — click to stop
        </button>
      )}
      {needsUnlock && (
        <button className="studio-banner action" onClick={() => void unlockAndFollow()}>
          🔊 Someone is playing — click to listen along
        </button>
      )}
      {recorder.error && (
        <button className="studio-banner error" onClick={recorder.clearError}>{recorder.error} (dismiss)</button>
      )}

      <StudioArrange
        doc={doc}
        trackIds={trackIds}
        pxPerBeat={pxPerBeat}
        totalBeats={totalBeats}
        snapGrid={grid}
        editable={editable}
        engine={engine}
        isPlaying={isPlaying}
        playheadBeats={playhead}
        selection={selection}
        onSelectionChange={setSelection}
        selectedTrackId={selectedTrackId}
        onSelectTrack={setSelectedTrackId}
        armedTrackIds={armedTrackIds}
        recordingTakes={midiRecording ? input.liveTakes(playhead) : []}
        onArmTrack={armTrack}
        levels={levels}
        peaksVersion={peaksVersion}
        presence={presence}
        assetIds={assetIds}
        followUserId={following}
        onSeek={seek}
        onOpenClip={openClip}
        onDeleteTrack={(id) => setConfirmDeleteTrack(id)}
        onZoom={(f) => setPxPerBeat((z) => Math.min(200, Math.max(4, z * f)))}
      />

      <div className={`studio-panel${panelOpen ? ' open' : ''}`} style={panelOpen ? { height: panelHeight } : undefined}>
        {panelOpen && (
          <div
            className="studio-panel-resize"
            title="Drag to resize · double-click to reset"
            onDoubleClick={() => { setPanelHeight(340); try { localStorage.setItem(PANEL_HEIGHT_KEY, '340'); } catch { /* ignore */ } }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              const startY = e.clientY, startH = panelHeight;
              const max = Math.max(PANEL_MIN, window.innerHeight * 0.8);
              let h = startH;
              const move = (ev: PointerEvent) => { h = Math.round(Math.min(max, Math.max(PANEL_MIN, startH + startY - ev.clientY))); setPanelHeight(h); };
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                try { localStorage.setItem(PANEL_HEIGHT_KEY, String(h)); } catch { /* ignore */ }
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
          />
        )}
        <div className="studio-panel-tabs">
          <button className={`studio-tab${panel === 'audio' && panelOpen ? ' active' : ''}`} onClick={() => { setPanel('audio'); setPanelOpen(true); }}>Audio</button>
          <button className={`studio-tab${panel === 'track' && panelOpen ? ' active' : ''}`} onClick={() => { setPanel('track'); setPanelOpen(true); }} disabled={!inspectedTrack}>
            Track{inspectedTrack ? `: ${inspectedTrack.name}` : ''}
          </button>
          <button className={`studio-tab${panel === 'editor' && panelOpen ? ' active' : ''}`} onClick={() => { setPanel('editor'); setPanelOpen(true); }} disabled={!editingClip}>
            Piano roll
          </button>
          <button className={`studio-tab${panel === 'master' && panelOpen ? ' active' : ''}`} onClick={() => { setPanel('master'); setPanelOpen(true); }} title="Master bus: limiter, glue compression, overall level">
            Master{meta.masterEffects?.length ? ` (${meta.masterEffects.length})` : ''}
          </button>
          <button className={`studio-tab${panel === 'history' && panelOpen ? ' active' : ''}`} onClick={() => { setPanel('history'); setPanelOpen(true); }} title="Who changed what, revert changes, saved versions">
            History
          </button>
          <div className="studio-spacer" />
          <button className="studio-btn icon small" onClick={() => setPanelOpen((o) => !o)} title={panelOpen ? 'Hide panel' : 'Show panel'}>
            {panelOpen ? '▾' : '▴'}
          </button>
        </div>
        {panelOpen && (
          <div className="studio-panel-body">
            {panel === 'audio' && (
              <StudioAssetBin
                editable={editable}
                canManage={canManage}
                onAddToTimeline={addAssetAtPlayhead}
                onMakeSampler={(a) => {
                  if (isSoundFontAsset(a)) {
                    const sf = getSoundFont(a.id);
                    const first = sf?.presets[0];
                    addTrack('instrument', 'soundfont', { assetId: a.id, bank: first?.bank ?? 0, program: first?.program ?? 0 }, a.name);
                  } else {
                    addTrack('instrument', 'sampler', { assetId: a.id, root: 60, mode: a.durationSec < 1.5 ? 'oneshot' : 'classic' }, a.name);
                  }
                  setPanel('track');
                  setPanelOpen(true);
                }}
              />
            )}
            {panel === 'track' && selection.length === 1 && doc.clips[selection[0]] && (
              <StudioClipProps doc={doc} clipId={selection[0]} clip={doc.clips[selection[0]]} editable={editable} />
            )}
            {panel === 'track' && inspectedTrack && selectedTrackId && (
              <StudioTrackInspector trackId={selectedTrackId} track={inspectedTrack} editable={editable} canManage={canManage} engine={engine} onAddReturn={() => addTrack('return')} />
            )}
            {panel === 'master' && (
              <StudioTrackInspector trackId={MASTER_ID} track={masterTrack(meta.masterEffects, meta.masterVolume)} editable={editable} canManage={canManage} engine={engine} />
            )}
            {panel === 'track' && !inspectedTrack && <div className="studio-message small">Select a track to edit its instrument and effects.</div>}
            {panel === 'editor' && editingClip && editingClipId && editLockedBy && editable && (
              <div className="studio-lock-banner" style={{ borderColor: colorForUser(editLockedBy) }}>
                🔒 {memberName(editLockedBy)} has this clip open too.
                {lockOverride === editingClipId
                  ? <span> You're both editing — the last change to each note wins.</span>
                  : <button className="studio-btn small" onClick={() => setLockOverride(editingClipId)}>Edit anyway</button>}
              </div>
            )}
            {panel === 'editor' && editingClip && editingTrack && editingClipId && (
              <PianoRoll
                clipId={editingClipId}
                clip={editingClip}
                track={editingTrack}
                trackId={editingClip.trackId}
                meta={meta}
                engine={engine}
                editable={rollEditable}
                playheadInClip={playhead >= editingClip.start && playhead <= editingClip.start + editingClip.length ? playhead - editingClip.start : null}
                onClose={() => { setEditingClipId(null); setPanel('audio'); }}
              />
            )}
            {panel === 'editor' && !editingClip && <div className="studio-message small">Double-click a MIDI clip to edit its notes.</div>}
            {panel === 'history' && (
              <StudioHistoryPanel channelId={channelId} doc={doc} editable={editable} canManage={canManage} myId={myId} />
            )}
          </div>
        )}
      </div>

      {showShortcuts && <StudioShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {midiImport && doc && (
        <MidiImportModal
          fileName={midiImport.name}
          info={midiImport.info}
          roomForTracks={Math.max(0, MAX_TRACKS - trackIds.length)}
          projectBpm={doc.meta.bpm}
          onImport={runMidiImport}
          onClose={() => setMidiImport(null)}
        />
      )}
      {confirmDeleteTrack && doc.tracks[confirmDeleteTrack] && (
        <ConfirmModal
          title="Delete track"
          message={`Delete "${doc.tracks[confirmDeleteTrack].name}"${doc.tracks[confirmDeleteTrack].kind === 'group' ? ' (the tracks inside go back to the master)' : ' and its clips'} for everyone? You can undo this.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { edit([{ t: 'del', path: ['tracks', confirmDeleteTrack] }]); }}
          onClose={() => setConfirmDeleteTrack(null)}
        />
      )}
    </div>
  );
}
