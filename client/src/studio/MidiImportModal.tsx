import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStudioStore } from '@abyss/shared';
import type { MidiFileInfo } from './midiImport';
import { isSoundFontAsset, isSoundFontFile } from './engine/soundfont';
import { uploadAudioFiles } from './studioUtils';

interface Props {
  fileName: string;
  info: MidiFileInfo;
  /** Tracks that can still be added before the studio's limit */
  roomForTracks: number;
  projectBpm: number;
  onImport: (keys: string[], opts: { tempo: boolean; timeSig: boolean; atStart: boolean; soundfontId?: string }) => void | Promise<void>;
  onClose: () => void;
}

const GM_DRUM_NOTE = 'Channel 10';

export default function MidiImportModal({ fileName, info, roomForTracks, projectBpm, onImport, onClose }: Props) {
  const assets = useStudioStore((s) => s.assets);
  const sfAssets = assets.filter(isSoundFontAsset);
  const stem = fileName.replace(/\.[^.]+$/, '').toLowerCase();
  const [soundfontId, setSoundfontId] = useState<string>(() => sfAssets.find((a) => a.name.toLowerCase() === stem)?.id ?? '');
  const [uploadingSf, setUploadingSf] = useState(false);
  const [importing, setImporting] = useState(false);
  const sfRef = useRef<HTMLInputElement>(null);

  const [picked, setPicked] = useState<Set<string>>(() => new Set(info.parts.slice(0, roomForTracks).map((p) => p.key)));
  const [tempo, setTempo] = useState(false);
  const [timeSig, setTimeSig] = useState(false);
  const [atStart, setAtStart] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (key: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const noteCount = (p: MidiFileInfo['parts'][number]) => (soundfontId && p.rawNotes?.length ? p.rawNotes.length : p.notes.length);
  const over = picked.size > roomForTracks;
  const total = info.parts.filter((p) => picked.has(p.key)).reduce((a, p) => a + noteCount(p), 0);

  const onUploadSf = async (files: File[]) => {
    const sfFile = files.find(isSoundFontFile);
    if (!sfFile) return;
    setUploadingSf(true);
    try {
      const [created] = await uploadAudioFiles([sfFile]);
      if (created) setSoundfontId(created.id);
    } finally {
      setUploadingSf(false);
    }
  };

  const submit = async () => {
    setImporting(true);
    try {
      await onImport(
        info.parts.filter((p) => picked.has(p.key)).map((p) => p.key),
        { tempo, timeSig, atStart, soundfontId: soundfontId || undefined },
      );
    } finally {
      setImporting(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal studio-midi-import" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Import MIDI">
        <div className="studio-shortcuts-head">
          <h2>Import MIDI</h2>
          <button className="studio-icon-btn" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <p className="studio-muted studio-midi-import-file">{fileName}</p>

        <div className="studio-midi-import-parts">
          {info.parts.map((p) => (
            <label key={p.key} className="studio-check studio-midi-import-part">
              <input type="checkbox" checked={picked.has(p.key)} onChange={() => toggle(p.key)} />
              <span className="studio-midi-import-name">{p.drums ? '🥁' : '🎹'} {p.name}</span>
              <span className="studio-muted">
                {noteCount(p)} notes{p.drums ? ` · ${GM_DRUM_NOTE}` : ''}
                {!soundfontId && p.unmapped ? ` · ${p.unmapped} hits with no kit piece skipped` : ''}
              </span>
            </label>
          ))}
        </div>

        <div className="studio-midi-import-opts">
          <div className="studio-midi-import-sf">
            <label className="studio-muted small" htmlFor="studio-midi-sf">SoundFont</label>
            <select
              id="studio-midi-sf"
              className="studio-select small"
              value={soundfontId}
              disabled={uploadingSf || importing}
              onChange={(e) => setSoundfontId(e.target.value)}
            >
              <option value="">Built-in synths / drum rack</option>
              {sfAssets.map((a) => <option key={a.id} value={a.id}>{a.name} ({(a.fileSize / (1024 * 1024)).toFixed(1)} MB)</option>)}
            </select>
            <button className="studio-btn small" type="button" disabled={uploadingSf || importing} onClick={() => sfRef.current?.click()}>
              {uploadingSf ? 'Uploading…' : 'Upload .sf2'}
            </button>
            <input
              ref={sfRef}
              type="file"
              accept=".sf2"
              hidden
              onChange={(e) => { void onUploadSf(Array.from(e.target.files ?? [])); e.target.value = ''; }}
            />
          </div>
          {info.bpm !== null && Math.abs(info.bpm - projectBpm) > 0.01 && (
            <label className="studio-check">
              <input type="checkbox" checked={tempo} onChange={(e) => setTempo(e.target.checked)} />
              Set project tempo to {info.bpm} BPM (now {projectBpm}){info.tempoChanges ? ' · the file changes tempo later; only the first tempo is used' : ''}
            </label>
          )}
          {info.timeSig && (
            <label className="studio-check">
              <input type="checkbox" checked={timeSig} onChange={(e) => setTimeSig(e.target.checked)} />
              Use the file's time signature ({info.timeSig.num}/{info.timeSig.den})
            </label>
          )}
          <label className="studio-check">
            <input type="checkbox" checked={atStart} onChange={(e) => setAtStart(e.target.checked)} />
            Place at the start of the song (otherwise at the playhead's bar)
          </label>
        </div>

        {over && <p className="studio-midi-import-warn">The studio has room for {roomForTracks} more track{roomForTracks === 1 ? '' : 's'}. Untick some parts.</p>}

        <div className="studio-midi-import-actions">
          <button className="studio-btn" onClick={onClose}>Cancel</button>
          <button className="studio-btn on" disabled={!picked.size || over || importing || uploadingSf} onClick={() => void submit()}>
            {importing ? 'Importing…' : `Import ${picked.size} track${picked.size === 1 ? '' : 's'} · ${total} notes`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
