import { useEffect, useRef, useState } from 'react';
import { useAuthStore, useStudioStore, useToastStore } from '@abyss/shared';
import type { StudioParams } from '@abyss/shared';
import { FACTORY_PRESETS, presetKey, savePreset, deletePreset, useSavedPresets, type PresetKind } from './presets';
import { memberName } from './studioUtils';

interface Props {
  kind: PresetKind;
  type: string;
  editable: boolean;
  canManage: boolean;
  /** Current settings (what "Save" stores) */
  current: () => StudioParams;
  onLoad: (params: StudioParams) => void;
}

/** "Presets ▾" in a device's title bar: built-ins, the server's library, save current. */
export default function PresetMenu({ kind, type, editable, canManage, current, onLoad }: Props) {
  const channelId = useStudioStore((s) => s.channelId);
  const myId = useAuthStore((s) => s.user?.id);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const saved = useSavedPresets(channelId, kind, type, open);
  const factory = FACTORY_PRESETS[presetKey(kind, type)] ?? [];

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const load = (p: StudioParams) => { onLoad(p); setOpen(false); };

  const save = async () => {
    const n = name.trim();
    if (!n || !channelId) return;
    setSaving(true);
    try {
      await savePreset(channelId, kind, type, n, current());
      setName('');
      useToastStore.getState().addToast(`Saved preset “${n}” for everyone in this server.`, 'success');
    } catch (e) {
      const msg = (e as { response?: { data?: unknown } })?.response?.data;
      useToastStore.getState().addToast(typeof msg === 'string' ? msg : 'Could not save the preset.', 'error');
    } finally { setSaving(false); }
  };

  return (
    <div className="studio-preset-menu" ref={ref}>
      <button className={`studio-btn small${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} title="Presets">Presets ▾</button>
      {open && (
        <div className="studio-preset-pop" onPointerDown={(e) => e.stopPropagation()}>
          {factory.length > 0 && <div className="studio-preset-head">Built-in</div>}
          {factory.map((p) => (
            <button key={p.name} className="studio-preset-item" disabled={!editable} onClick={() => load(p.params)}>{p.name}</button>
          ))}
          <div className="studio-preset-head">Shared in this server</div>
          {saved.length === 0 && <div className="studio-preset-empty">None yet</div>}
          {saved.map((p) => (
            <div key={p.id} className="studio-preset-row">
              <button className="studio-preset-item" disabled={!editable} onClick={() => load(p.params)} title={`Saved by ${memberName(p.createdById)}`}>{p.name}</button>
              {(p.createdById === myId || canManage) && channelId && (
                <button
                  className="studio-icon-btn danger"
                  title="Delete preset"
                  onClick={() => { deletePreset(channelId, kind, type, p.id).catch(() => useToastStore.getState().addToast('Could not delete the preset.', 'error')); }}
                >✕</button>
              )}
            </div>
          ))}
          {editable && (
            <form className="studio-preset-save" onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <input value={name} maxLength={60} placeholder="Save current as…" onChange={(e) => setName(e.target.value)} />
              <button className="studio-btn small on" type="submit" disabled={!name.trim() || saving}>Save</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
