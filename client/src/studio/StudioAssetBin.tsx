import { isMidiFile } from './midiImport';
import { useEffect, useRef, useState } from 'react';
import { api, useStudioStore, useAuthStore, useToastStore } from '@abyss/shared';
import ConfirmModal from '../components/ConfirmModal';
import type { StudioAsset } from '@abyss/shared';
import { assetUrl } from './engine/assetCache';
import { ASSET_DRAG_TYPE } from './StudioArrange';
import { formatDuration, memberName, uploadAudioFiles } from './studioUtils';

interface Props {
  editable: boolean;
  canManage: boolean;
  onAddToTimeline: (asset: StudioAsset) => void;
  onMakeSampler: (asset: StudioAsset) => void;
}

export default function StudioAssetBin({ editable, canManage, onAddToTimeline, onMakeSampler }: Props) {
  const assets = useStudioStore((s) => s.assets);
  const doc = useStudioStore((s) => s.doc);
  const deleteAsset = useStudioStore((s) => s.deleteAsset);
  const myId = useAuthStore((s) => s.user?.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [dragOver, setDragOver] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; message: string; label: string; run: () => Promise<void> } | null>(null);
  const channelId = useStudioStore((s) => s.channelId);

  const usage = new Map<string, number>();
  for (const c of Object.values(doc?.clips ?? {})) if (c.assetId) usage.set(c.assetId, (usage.get(c.assetId) ?? 0) + 1);
  // Samplers and drum-rack pads use audio too (by id inside their params).
  const instJson = JSON.stringify(Object.values(doc?.tracks ?? {}).map((t) => t.instrument?.params ?? null));
  const inInstrument = (id: string) => instJson.includes(id);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    await uploadAudioFiles(files, (name, pct) => setUploads((u) => ({ ...u, [name]: pct })));
    setUploads((u) => {
      const next = { ...u };
      for (const f of files) delete next[f.name];
      return next;
    });
  };

  // One player per previewed file so pause → play resumes where it stopped.
  const players = useRef(new Map<string, HTMLAudioElement>());
  useEffect(() => () => { for (const el of players.current.values()) el.pause(); }, []);

  const togglePreview = (asset: StudioAsset) => {
    if (playing === asset.id) {
      players.current.get(asset.id)?.pause();
      setPlaying(null);
      return;
    }
    if (playing) players.current.get(playing)?.pause();
    let el = players.current.get(asset.id);
    if (!el) {
      el = new Audio(assetUrl(asset.url));
      el.onended = () => { el!.currentTime = 0; setPlaying((p) => (p === asset.id ? null : p)); };
      players.current.set(asset.id, el);
    }
    void el.play().catch(() => setPlaying(null));
    setPlaying(asset.id);
  };

  const remove = async (asset: StudioAsset, force = false) => {
    try {
      await deleteAsset(asset.id, force);
    } catch (e: unknown) {
      const res = (e as { response?: { status?: number; data?: unknown } })?.response;
      if (res?.status === 409 && !force) {
        const data = res.data as { message?: string } | undefined;
        setConfirm({
          title: 'Delete audio used by saved versions?',
          message: `${data?.message ?? 'Saved versions use this audio.'} Delete “${asset.name}” anyway?`,
          label: 'Delete anyway',
          run: () => remove(asset, true),
        });
        return;
      }
      const msg = res?.data;
      useToastStore.getState().addToast(typeof msg === 'string' ? msg : 'Could not delete audio.', 'error');
    }
  };

  /** Find files nothing uses (not the project, not any saved version) and offer to delete them. */
  const cleanup = async () => {
    if (!channelId) return;
    try {
      const res = await api.get<{ id: string; inProject: boolean; versions: number; fileSize: number }[]>(`/channels/${channelId}/studio/assets/usage`);
      const unused = res.data.filter((u) => !u.inProject && u.versions === 0 && (canManage || assets.find((a) => a.id === u.id)?.uploadedById === myId));
      if (!unused.length) { useToastStore.getState().addToast('Every audio file is in use (by the project or a saved version).', 'info'); return; }
      const mb = unused.reduce((n, u) => n + u.fileSize, 0) / (1024 * 1024);
      setConfirm({
        title: 'Clean up unused audio',
        message: `${unused.length} file${unused.length === 1 ? '' : 's'} (${mb.toFixed(1)} MB) aren't used by the project or any saved version${canManage ? '' : ' (only your uploads are included)'}. Delete them for everyone? This can't be undone.`,
        label: 'Delete unused',
        run: async () => {
          const r = await api.post<{ deleted: number }>(`/channels/${channelId}/studio/assets/cleanup`);
          useToastStore.getState().addToast(`Deleted ${r.data.deleted} unused file${r.data.deleted === 1 ? '' : 's'}.`, 'success');
        },
      });
    } catch {
      useToastStore.getState().addToast('Could not check audio usage.', 'error');
    }
  };

  return (
    <div
      className={`studio-asset-bin${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => { if (editable && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { setDragOver(false); if (!editable) return; e.preventDefault(); void upload(Array.from(e.dataTransfer.files).filter((f) => !isMidiFile(f))); }}
    >
      <div className="studio-panel-toolbar">
        <span className="studio-panel-title">🎵 Audio</span>
        <span className="studio-muted">{assets.length} file{assets.length === 1 ? '' : 's'}</span>
        <div className="studio-spacer" />
        {editable && (
          <>
            {assets.length > 0 && <button className="studio-btn small" onClick={() => void cleanup()} title="Delete audio files nothing uses">Clean up…</button>}
            <button className="studio-btn small" onClick={() => fileRef.current?.click()}>Upload audio</button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.webm"
              multiple
              hidden
              onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }}
            />
          </>
        )}
      </div>
      <div className="studio-asset-list">
        {Object.entries(uploads).map(([name, pct]) => (
          <div key={`up-${name}`} className="studio-asset uploading">
            <span className="studio-asset-name">{name}</span>
            <div className="studio-asset-progress"><div style={{ width: `${pct}%` }} /></div>
          </div>
        ))}
        {assets.length === 0 && Object.keys(uploads).length === 0 && (
          <div className="studio-asset-empty">
            {editable ? 'Drop audio files here or upload them, then drag onto an audio track.' : 'No audio in this project yet.'}
          </div>
        )}
        {assets.map((a) => (
          <div
            key={a.id}
            className="studio-asset"
            draggable={editable}
            onDragStart={(e) => {
              e.dataTransfer.setData(ASSET_DRAG_TYPE, a.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            title={`Uploaded by ${memberName(a.uploadedById)}`}
          >
            <button className="studio-icon-btn" onClick={() => togglePreview(a)} title="Preview">{playing === a.id ? '■' : '▶'}</button>
            <span className="studio-asset-name">{a.name}</span>
            <span className="studio-muted">{formatDuration(a.durationSec)}</span>
            {usage.get(a.id) ? <span className="studio-asset-uses" title="Clips using this audio">×{usage.get(a.id)}</span> : null}
            {editable && (
              <button className="studio-icon-btn" onClick={() => onAddToTimeline(a)} title="Add at playhead">＋</button>
            )}
            {editable && (
              <button className="studio-icon-btn" onClick={() => onMakeSampler(a)} title="New sampler track playing this sound">🎹</button>
            )}
            {inInstrument(a.id) && <span className="studio-asset-uses" title="Used by a sampler or drum pad">🎹</span>}
            {(a.uploadedById === myId || canManage) && !usage.get(a.id) && !inInstrument(a.id) && (
              <button className="studio-icon-btn danger" onClick={() => void remove(a)} title="Delete">🗑</button>
            )}
          </div>
        ))}
      </div>
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          danger
          onConfirm={() => { void confirm.run().catch(() => useToastStore.getState().addToast('That failed.', 'error')); }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
