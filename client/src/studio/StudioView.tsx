import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Tone from 'tone';
import {
  useStudioStore, useAuthStore, useServerStore, useToastStore, getApiBase,
  hasChannelPermission, Permission, studioId, sortedTrackIds, arrangementEnd, secondsToBeats, beatsToSeconds,
} from '@abyss/shared';
import type { StudioOp, StudioClip, StudioAsset, StudioNote } from '@abyss/shared';
import { isMobile } from '../stores/mobileStore';
import ConfirmModal from '../components/ConfirmModal';
import { StudioEngine } from './engine/StudioEngine';
import { loadAsset, onAssetLoaded } from './engine/assetCache';
import { renderProjectToWav } from './engine/exportWav';
import StudioArrange from './StudioArrange';
import PianoRoll from './PianoRoll';
import StudioAssetBin from './StudioAssetBin';
import StudioTrackInspector from './StudioTrackInspector';
import { useStudioRecorder, getRecordLatencyMs, setRecordLatencyMs } from './useStudioRecorder';
import {
  SNAP_OPTIONS, snapSize, formatPosition, barBeats, nextTrackOrder, nextTrackColor,
  isTypingTarget, colorForUser, audioClipOp,
} from './studioUtils';

interface Props {
  channelId: string;
  /** Embedded in a voice channel: smaller default panels */
  compact?: boolean;
}

type PanelTab = 'audio' | 'track' | 'editor';

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
  const [playhead, setPlayhead] = useState(0);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [peaksVersion, setPeaksVersion] = useState(0);
  const [pxPerBeat, setPxPerBeat] = useState(compact ? 16 : 24);
  const [snap, setSnap] = useState(1);
  const [metronome, setMetronome] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [armedTrackId, setArmedTrackId] = useState<string | null>(null);
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelTab>('audio');
  const [panelOpen, setPanelOpen] = useState(!compact);
  const [exporting, setExporting] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [confirmDeleteTrack, setConfirmDeleteTrack] = useState<string | null>(null);
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState(getRecordLatencyMs);
  const recorder = useStudioRecorder(engine);

  const canManage = hasChannelPermission(channel?.permissions, Permission.ManageStudio);
  const editable = canEditPerm && !isMobile();

  // ───────────── Lifecycle ─────────────

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
    if (engine) engine.setMetronome(metronome);
  }, [engine, metronome]);

  // Decode every asset the arrangement uses; re-sync once each lands.
  useEffect(() => {
    return onAssetLoaded(() => {
      engine?.refresh();
      setPeaksVersion((v) => v + 1);
    });
  }, [engine]);

  useEffect(() => {
    if (!doc) return;
    const used = new Set(Object.values(doc.clips).map((c) => c.assetId).filter(Boolean));
    for (const a of assets) {
      if (used.has(a.id)) loadAsset(a.id, a.url).catch((e) => console.warn('[studio] asset load failed', a.name, e));
    }
  }, [doc, assets]);

  // Drop selection / editor state for things collaborators deleted.
  useEffect(() => {
    if (!doc) return;
    setSelection((sel) => (sel.every((id) => doc.clips[id]) ? sel : sel.filter((id) => doc.clips[id])));
    if (editingClipId && !doc.clips[editingClipId]) setEditingClipId(null);
    if (selectedTrackId && !doc.tracks[selectedTrackId]) setSelectedTrackId(null);
    if (armedTrackId && !doc.tracks[armedTrackId]) setArmedTrackId(null);
  }, [doc, editingClipId, selectedTrackId, armedTrackId]);

  useEffect(() => { setLocalPresence({ selection }); }, [selection, setLocalPresence]);
  useEffect(() => { setLocalPresence({ editingClipId }); }, [editingClipId, setLocalPresence]);

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

  // ───────────── Transport ─────────────

  const play = useCallback(async (from: number, broadcast: boolean) => {
    if (!engine) return;
    await engine.play(from);
    setNeedsUnlock(false);
    setIsPlaying(true);
    if (broadcast && useStudioStore.getState().followTransport) sendTransport(true, from);
  }, [engine, sendTransport]);

  const stop = useCallback((broadcast: boolean) => {
    if (!engine) return;
    engine.stop();
    const pos = engine.getPositionBeats();
    setPlayhead(pos);
    setIsPlaying(false);
    if (broadcast && useStudioStore.getState().followTransport) sendTransport(false, pos);
  }, [engine, sendTransport]);

  const togglePlay = useCallback(() => {
    if (recorder.state === 'recording') { void recorder.stop(); setIsPlaying(false); return; }
    if (isPlaying) stop(true);
    else void play(playhead, true);
  }, [isPlaying, play, stop, playhead, recorder]);

  const seek = useCallback((beats: number) => {
    setPlayhead(beats);
    if (!engine) return;
    if (isPlaying) {
      void play(beats, true);
    } else {
      engine.seek(beats);
      if (useStudioStore.getState().followTransport) sendTransport(false, beats);
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
    let pos = transport.positionBeats + secondsToBeats(elapsed, meta?.bpm ?? 120);
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
      const bpm = useStudioStore.getState().doc?.meta.bpm ?? 120;
      void play(t.positionBeats + secondsToBeats(Math.max(0, (Date.now() + offset - t.serverTimeMs) / 1000), bpm), false);
    }
  };

  const toggleRecord = async () => {
    if (recorder.state === 'recording') {
      await recorder.stop();
      setIsPlaying(false);
      return;
    }
    if (!armedTrackId) {
      useToastStore.getState().addToast('Arm an audio track (●) to record onto it.', 'info');
      return;
    }
    if (isPlaying) stop(true);
    await recorder.start(armedTrackId, playhead);
    setIsPlaying(true);
  };

  // ───────────── Editing helpers ─────────────

  const trackIds = useMemo(() => (doc ? sortedTrackIds(doc) : []), [doc]);
  const grid = doc ? snapSize(snap, doc.meta) : 1;

  const addTrack = (kind: 'audio' | 'instrument', instrument?: 'synth' | 'drums' | 'bass') => {
    if (!doc) return;
    const id = studioId();
    const count = Object.values(doc.tracks).filter((t) => t.kind === kind).length + 1;
    const name = kind === 'audio' ? `Audio ${count}` : instrument === 'drums' ? `Drums ${count}` : instrument === 'bass' ? `Bass ${count}` : `Synth ${count}`;
    edit([{
      t: 'set', path: ['tracks', id], value: {
        name, kind, order: nextTrackOrder(doc), color: nextTrackColor(doc),
        volume: kind === 'audio' ? 0 : -6, pan: 0, mute: false, solo: false,
        ...(kind === 'instrument' ? { instrument: { type: instrument ?? 'synth' } } : {}),
      },
    }]);
    setSelectedTrackId(id);
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
      const right: StudioClip = { ...c, start: p, length: c.length - leftLen };
      const left: StudioClip = { ...c, length: leftLen };
      if (c.kind === 'audio') {
        right.offset = (c.offset ?? 0) + beatsToSeconds(leftLen, doc.meta.bpm);
      } else {
        const ln: Record<string, StudioNote> = {}, rn: Record<string, StudioNote> = {};
        for (const [nid, n] of Object.entries(c.notes ?? {})) {
          if (n.start < leftLen) ln[nid] = { ...n, len: Math.min(n.len, leftLen - n.start) };
          else rn[nid] = { ...n, start: n.start - leftLen };
        }
        left.notes = ln;
        right.notes = rn;
      }
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
    ops.push(audioClipOp(asset, trackId, playhead, doc.meta.bpm));
    edit(ops);
  };

  const commitBpm = () => {
    if (bpmDraft == null || !doc) return;
    const v = Math.round(Number(bpmDraft) * 10) / 10;
    setBpmDraft(null);
    if (Number.isFinite(v) && v >= 20 && v <= 400 && v !== doc.meta.bpm) edit([{ t: 'set', path: ['meta', 'bpm'], value: v }]);
  };

  const exportWav = async () => {
    if (!doc || exporting) return;
    setExporting(true);
    try {
      const blob = await renderProjectToWav(doc, assets);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${channel?.name ?? 'studio'}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      console.error('[studio] export failed', e);
      useToastStore.getState().addToast('Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const openClip = (id: string) => {
    setEditingClipId(id);
    setPanel('editor');
    setPanelOpen(true);
  };

  // ───────────── Keyboard ─────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('.modal-overlay')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
      if (!editable) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
      if (mod) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
      if (e.key.toLowerCase() === 's') { e.preventDefault(); splitAtPlayhead(); return; }
      if (e.key === 'Escape') setSelection([]);
      if (e.key === 'Enter') seek(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable, togglePlay, undo, redo, duplicateSelected, deleteSelected, splitAtPlayhead, seek]);

  // ───────────── Render ─────────────

  if (error) return <div className="studio-view"><div className="studio-message">{error}</div></div>;
  if (loading || !doc) return <div className="studio-view"><div className="studio-message">Loading studio…</div></div>;

  const meta = doc.meta;
  const totalBeats = Math.max(arrangementEnd(doc) + barBeats(meta) * 8, barBeats(meta) * 32);
  const editingClip = editingClipId ? doc.clips[editingClipId] : undefined;
  const editingTrack = editingClip ? doc.tracks[editingClip.trackId] : undefined;
  const inspectedTrack = selectedTrackId ? doc.tracks[selectedTrackId] : undefined;
  const others = users.filter((u) => u !== myId);
  const recording = recorder.state === 'recording';

  return (
    <div className={`studio-view${compact ? ' compact' : ''}`}>
      <div className="studio-toolbar">
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
              title={armedTrackId ? 'Record onto the armed track' : 'Arm an audio track to record'}
            >
              {recorder.state === 'uploading' ? '…' : '⏺'}
            </button>
          )}
          <div className="studio-position" title="Bar.Beat.Sixteenth">{formatPosition(playhead, meta)}</div>
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
          <button className="studio-btn icon" onClick={() => setPxPerBeat((z) => Math.max(4, z / 1.25))} title="Zoom out">−</button>
          <button className="studio-btn icon" onClick={() => setPxPerBeat((z) => Math.min(200, z * 1.25))} title="Zoom in">+</button>
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
                if (v === 'audio') addTrack('audio');
                else if (v) addTrack('instrument', v as 'synth' | 'drums' | 'bass');
              }}
              disabled={trackIds.length >= 32}
              title="Add track"
            >
              <option value="">＋ Track</option>
              <option value="audio">Audio</option>
              <option value="synth">Synth</option>
              <option value="drums">Drums</option>
              <option value="bass">Bass</option>
            </select>
          </div>
        )}

        <div className="studio-spacer" />

        <div className="studio-toolbar-group">
          <label className="studio-check" title="Share play/stop with everyone who has sync on, and follow theirs">
            <input type="checkbox" checked={followTransport} onChange={(e) => setFollowTransport(e.target.checked)} />
            Sync playback
          </label>
          <button className="studio-btn" onClick={() => void exportWav()} disabled={exporting} title="Render the project to a WAV file">
            {exporting ? 'Rendering…' : '⤓ WAV'}
          </button>
          <div className="studio-avatars" title={`${users.length} in studio`}>
            {myId && users.includes(myId) && <Avatar userId={myId} />}
            {others.slice(0, 6).map((u) => <Avatar key={u} userId={u} />)}
            {others.length > 6 && <div className="studio-avatar more">+{others.length - 6}</div>}
          </div>
          <span className={`studio-sync-dot${pendingCount ? ' pending' : ''}`} title={pendingCount ? 'Saving edits…' : 'All edits synced'} />
        </div>
      </div>

      {!canEditPerm && <div className="studio-banner">You can listen to this studio, but you don't have permission to edit it.</div>}
      {canEditPerm && isMobile() && <div className="studio-banner">Editing is available on desktop. You can still listen here.</div>}
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
        armedTrackId={armedTrackId}
        onArmTrack={(id) => setArmedTrackId((a) => (a === id ? null : id))}
        levels={levels}
        peaksVersion={peaksVersion}
        presence={presence}
        onSeek={seek}
        onOpenClip={openClip}
        onDeleteTrack={(id) => setConfirmDeleteTrack(id)}
      />

      <div className={`studio-panel${panelOpen ? ' open' : ''}`}>
        <div className="studio-panel-tabs">
          <button className={`studio-tab${panel === 'audio' && panelOpen ? ' active' : ''}`} onClick={() => { setPanel('audio'); setPanelOpen(true); }}>Audio</button>
          <button className={`studio-tab${panel === 'track' && panelOpen ? ' active' : ''}`} onClick={() => { setPanel('track'); setPanelOpen(true); }} disabled={!inspectedTrack}>
            Track{inspectedTrack ? `: ${inspectedTrack.name}` : ''}
          </button>
          <button className={`studio-tab${panel === 'editor' && panelOpen ? ' active' : ''}`} onClick={() => { setPanel('editor'); setPanelOpen(true); }} disabled={!editingClip}>
            Piano roll
          </button>
          <div className="studio-spacer" />
          {panel === 'audio' && panelOpen && editable && (
            <label className="studio-field small" title="Shifts recorded takes earlier to compensate for input latency">
              <span>Rec latency</span>
              <input
                type="number" min={0} max={1000} step={5}
                value={latencyMs}
                onChange={(e) => { const v = Number(e.target.value); setLatencyMs(v); setRecordLatencyMs(v); }}
              />
              <span>ms</span>
            </label>
          )}
          <button className="studio-btn icon small" onClick={() => setPanelOpen((o) => !o)} title={panelOpen ? 'Hide panel' : 'Show panel'}>
            {panelOpen ? '▾' : '▴'}
          </button>
        </div>
        {panelOpen && (
          <div className="studio-panel-body">
            {panel === 'audio' && (
              <StudioAssetBin editable={editable} canManage={canManage} onAddToTimeline={addAssetAtPlayhead} />
            )}
            {panel === 'track' && inspectedTrack && selectedTrackId && (
              <StudioTrackInspector trackId={selectedTrackId} track={inspectedTrack} editable={editable} />
            )}
            {panel === 'track' && !inspectedTrack && <div className="studio-message small">Select a track to edit its instrument and effects.</div>}
            {panel === 'editor' && editingClip && editingTrack && editingClipId && (
              <PianoRoll
                clipId={editingClipId}
                clip={editingClip}
                track={editingTrack}
                trackId={editingClip.trackId}
                meta={meta}
                engine={engine}
                editable={editable}
                snapGrid={grid > barBeats(meta) / 2 ? 0.25 : grid}
                playheadInClip={playhead >= editingClip.start && playhead <= editingClip.start + editingClip.length ? playhead - editingClip.start : null}
                onClose={() => { setEditingClipId(null); setPanel('audio'); }}
              />
            )}
            {panel === 'editor' && !editingClip && <div className="studio-message small">Double-click a MIDI clip to edit its notes.</div>}
          </div>
        )}
      </div>

      {confirmDeleteTrack && doc.tracks[confirmDeleteTrack] && (
        <ConfirmModal
          title="Delete track"
          message={`Delete "${doc.tracks[confirmDeleteTrack].name}" and its clips for everyone? You can undo this.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { edit([{ t: 'del', path: ['tracks', confirmDeleteTrack] }]); }}
          onClose={() => setConfirmDeleteTrack(null)}
        />
      )}
    </div>
  );
}
