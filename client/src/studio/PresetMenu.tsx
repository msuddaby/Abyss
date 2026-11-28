import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

const POP_W = 230;
const POP_MAX_H = 320;

/** "Presets ▾" in a device's title bar: built-ins, the server's library, save current. */
export default function PresetMenu({ kind, type, editable, canManage, current, onLoad }: Props) {
  const channelId = useStudioStore((s) => s.channelId);
  const myId = useAuthStore((s) => s.user?.id);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const saved = useSavedPresets(channelId, kind, type, open);
  const factory = FACTORY_PRESETS[presetKey(kind, type)] ?? [];

  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos(null); return; }
    const updatePos = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const left = Math.max(8, Math.min(window.innerWidth - POP_W - 8, r.right - POP_W));
      const spaceBelow = window.innerHeight - r.bottom - 8;
      if (spaceBelow >= Math.min(200, POP_MAX_H)) {
        setPos({ left, top: r.bottom + 4 });
      } else {
        setPos({ left, bottom: Math.max(8, window.innerHeight - r.top + 4) });
      }
    };
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
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
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="studio-preset-pop"
          style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, right: 'auto' }}
          onPointerDown={(e) => e.stopPropagation()}
        >
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
        </div>,
        document.body,
      )}
    </div>
  );
}
