import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getAt, useStudioStore, useToastStore } from '@abyss/shared';
import type { StudioChangeEntry, StudioDoc, StudioOp, StudioVersionInfo } from '@abyss/shared';
import ConfirmModal from '../components/ConfirmModal';
import { colorForUser, memberName } from './studioUtils';
import { batchOps } from './midiImport';

// Git-style history for a studio: who changed what (with per-change revert),
// and saved versions you can compare against or restore.

interface Props {
  channelId: string;
  doc: StudioDoc;
  editable: boolean;
  canManage: boolean;
  myId: string | undefined;
}

interface Group {
  key: string;
  userId: string;
  kind: 'edit' | 'restore';
  changes: StudioChangeEntry[];
  /** Newest first */
  start: string;
  end: string;
}

/** Consecutive edits by one person within this gap read as one change. */
const GROUP_GAP_MS = 90_000;
const SEEN_KEY = (id: string) => `studio.historySeen.${id}`;

function readSeen(channelId: string): number {
  try { return Number(localStorage.getItem(SEEN_KEY(channelId))) || 0; } catch { return 0; }
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function group(changes: StudioChangeEntry[]): Group[] {
  const out: Group[] = [];
  for (const c of changes) {
    const g = out[out.length - 1];
    const t = new Date(c.createdAt).getTime();
    if (g && g.userId === c.userId && g.kind === 'edit' && c.kind === 'edit' && new Date(g.end).getTime() - t < GROUP_GAP_MS) {
      g.changes.push(c);
      g.end = c.createdAt;
    } else {
      out.push({ key: String(c.id), userId: c.userId, kind: c.kind, changes: [c], start: c.createdAt, end: c.createdAt });
    }
  }
  return out;
}

/** "Added a clip · Mixer — Bass" ×3 → distinct parts, most common first. */
function groupSummary(g: Group): string {
  const counts = new Map<string, number>();
  for (const c of g.changes) counts.set(c.summary, (counts.get(c.summary) ?? 0) + 1);
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => (n > 1 ? `${s} (×${n})` : s));
  return parts.slice(0, 3).join('; ') + (parts.length > 3 ? `; +${parts.length - 3} more` : '');
}

/** Key-order-insensitive: the server re-validates restored objects, which can reorder keys. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** What changed between a saved version and the live project, per track. */
function diffDocs(from: StudioDoc, to: StudioDoc): string[] {
  const lines: string[] = [];
  const m0 = from.meta ?? ({} as StudioDoc['meta']), m1 = to.meta;
  if (m0.bpm !== m1.bpm) lines.push(`Tempo ${m0.bpm} → ${m1.bpm} BPM`);
  if (m0.timeSigNum !== m1.timeSigNum || m0.timeSigDen !== m1.timeSigDen) lines.push(`Time signature ${m0.timeSigNum}/${m0.timeSigDen} → ${m1.timeSigNum}/${m1.timeSigDen}`);
  if (m0.scaleMode !== m1.scaleMode || m0.scaleRoot !== m1.scaleRoot) lines.push('Scale changed');
  if (!same(m0.masterEffects ?? [], m1.masterEffects ?? []) || (m0.masterVolume ?? 0) !== (m1.masterVolume ?? 0)) lines.push('Master bus changed');
  if (!same(from.tempo ?? {}, to.tempo ?? {})) lines.push(`Tempo map: ${Object.keys(from.tempo ?? {}).length} → ${Object.keys(to.tempo ?? {}).length} changes`);
  const mk0 = Object.values(from.markers ?? {}).map((m) => m.name), mk1 = Object.values(to.markers ?? {}).map((m) => m.name);
  if (!same(from.markers ?? {}, to.markers ?? {})) lines.push(`Markers: ${mk0.join(', ') || 'none'} → ${mk1.join(', ') || 'none'}`);
  const t0 = from.tracks ?? {}, t1 = to.tracks ?? {};
  const c0 = from.clips ?? {}, c1 = to.clips ?? {};
  const clipsOf = (clips: StudioDoc['clips'], trackId: string) => Object.entries(clips).filter(([, c]) => c.trackId === trackId);
  for (const id of new Set([...Object.keys(t0), ...Object.keys(t1)])) {
    const a = t0[id], b = t1[id];
    if (!a && b) { lines.push(`+ ${b.name} (new track, ${clipsOf(c1, id).length} clips)`); continue; }
    if (a && !b) { lines.push(`− ${a.name} (deleted, had ${clipsOf(c0, id).length} clips)`); continue; }
    const bits: string[] = [];
    if (a.name !== b.name) bits.push(`renamed from ${a.name}`);
    if (!same(a.instrument, b.instrument)) bits.push('instrument');
    if (!same(a.effects, b.effects)) bits.push('effects');
    if (a.volume !== b.volume || a.pan !== b.pan || a.mute !== b.mute || a.solo !== b.solo) bits.push('mixer');
    if ((a.output ?? '') !== (b.output ?? '') || !same(a.sends ?? {}, b.sends ?? {})) bits.push('routing');
    if (!same(a.automation, b.automation)) bits.push('automation');
    const before = new Map(clipsOf(c0, id)), after = new Map(clipsOf(c1, id));
    let added = 0, removed = 0, changed = 0;
    for (const [cid, c] of after) { const o = before.get(cid); if (!o) added++; else if (!same(o, c)) changed++; }
    for (const cid of before.keys()) if (!after.has(cid)) removed++;
    if (added) bits.push(`${added} clip${added === 1 ? '' : 's'} added`);
    if (removed) bits.push(`${removed} removed`);
    if (changed) bits.push(`${changed} edited`);
    if (bits.length) lines.push(`${b.name}: ${bits.join(', ')}`);
  }
  return lines.length ? lines : ['No differences: the project matches this version.'];
}

export default function StudioHistoryPanel({ channelId, doc, editable, canManage, myId }: Props) {
  const version = useStudioStore((s) => s.version);
  const versionsTick = useStudioStore((s) => s.versionsTick);
  const edit = useStudioStore((s) => s.edit);
  const toast = useToastStore.getState().addToast;

  const [changes, setChanges] = useState<StudioChangeEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [versions, setVersions] = useState<StudioVersionInfo[]>([]);
  const [onlyOthers, setOnlyOthers] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ id: string; lines: string[] } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; label: string; danger?: boolean; run: () => Promise<void> } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Highlight others' changes made since you last looked.
  const seenAtOpen = useRef(readSeen(channelId));

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.get<StudioChangeEntry[]>(`/channels/${channelId}/studio/history`, { params: { limit: 100 } });
      setChanges(res.data);
      setHasMore(res.data.length === 100);
      const newest = res.data[0]?.id;
      if (newest) try { localStorage.setItem(SEEN_KEY(channelId), String(newest)); } catch { /* ignore */ }
    } catch { /* offline: keep what we have */ }
  }, [channelId]);

  const loadMore = async () => {
    const last = changes[changes.length - 1];
    if (!last) return;
    const res = await api.get<StudioChangeEntry[]>(`/channels/${channelId}/studio/history`, { params: { before: last.id, limit: 100 } });
    setChanges((c) => [...c, ...res.data]);
    setHasMore(res.data.length === 100);
  };

  const loadVersions = useCallback(async () => {
    try { setVersions((await api.get<StudioVersionInfo[]>(`/channels/${channelId}/studio/versions`)).data); } catch { /* ignore */ }
  }, [channelId]);

  // Refresh shortly after edits settle (the server flushes history every few seconds).
  useEffect(() => {
    const t = window.setTimeout(() => void loadHistory(), version ? 1500 : 0);
    return () => window.clearTimeout(t);
  }, [loadHistory, version]);
  useEffect(() => { void loadVersions(); }, [loadVersions, versionsTick]);

  const groups = useMemo(() => group(changes).filter((g) => !onlyOthers || g.userId !== myId), [changes, onlyOthers, myId]);

  // ───────────── Revert ─────────────

  const revert = async (g: Group) => {
    if (!editable) return;
    setBusy(g.key);
    try {
      const res = await api.post<{ inverse: StudioOp[]; forward: StudioOp[]; skipped: number }>(`/channels/${channelId}/studio/history/revert`, { ids: g.changes.map((c) => c.id) });
      const { inverse, forward } = res.data;
      if (!inverse.length) { toast('Nothing to revert there.', 'info'); return; }
      // Later edits to the same things? Compare what this change left with what's there now.
      const last = new Map<string, StudioOp>();
      for (const op of forward) last.set(op.path.join('/'), op);
      const current = useStudioStore.getState().doc ?? doc;
      let conflicts = 0;
      for (const op of last.values()) {
        const expected = op.t === 'set' ? op.value : undefined;
        if (!same(getAt(current, op.path), expected)) conflicts++;
      }
      const apply = async () => {
        for (const batch of batchOps(inverse)) edit(batch);
        toast(`Reverted ${memberName(g.userId) === 'Someone' ? 'the' : `${memberName(g.userId)}'s`} change. Undo (Ctrl+Z) brings it back.`, 'success');
      };
      if (conflicts) {
        setConfirm({
          title: 'Revert over later edits?',
          message: `${conflicts} thing${conflicts === 1 ? ' this change touched was' : 's this change touched were'} edited again afterwards. Reverting puts them back to how they were before this change, overwriting those later edits.`,
          label: 'Revert anyway', danger: true, run: apply,
        });
      } else await apply();
    } catch {
      toast('Could not load that change.', 'error');
    } finally {
      setBusy(null);
    }
  };

  // ───────────── Versions ─────────────

  const saveVersion = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy('save');
    try {
      await api.post(`/channels/${channelId}/studio/versions`, { name: n });
      setName('');
      void loadVersions();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: unknown } })?.response?.data;
      toast(typeof msg === 'string' ? msg : 'Could not save the version.', 'error');
    } finally { setBusy(null); }
  };

  const restore = async (v: StudioVersionInfo) => {
    // Warn when the version uses audio that has since been deleted (those clips would be silent).
    let missing = 0;
    try {
      const res = await api.get<StudioDoc>(`/channels/${channelId}/studio/versions/${v.id}`);
      const have = new Set(useStudioStore.getState().assets.map((a) => a.id));
      missing = Object.values(res.data.clips ?? {}).filter((c) => c.assetId && !have.has(c.assetId)).length;
    } catch { /* restore still works; just no warning */ }
    restoreConfirm(v, missing);
  };

  const restoreConfirm = (v: StudioVersionInfo, missing: number) => setConfirm({
    title: 'Restore this version?',
    message: `This replaces the project for everyone with "${v.auto ? `Auto-save, ${new Date(v.createdAt).toLocaleString()}` : v.name}". The current state is saved first as an automatic version, so you can come back to it.`
      + (missing ? ` Note: ${missing} clip${missing === 1 ? '' : 's'} in it use${missing === 1 ? 's' : ''} audio that has since been deleted and will be silent (marked “missing”).` : ''),
    label: 'Restore', danger: true,
    run: async () => {
      try { await api.post(`/channels/${channelId}/studio/versions/${v.id}/restore`); }
      catch { toast('Restore failed.', 'error'); }
    },
  });

  const remove = (v: StudioVersionInfo) => setConfirm({
    title: 'Delete this version?', message: `"${v.name}" will be gone for everyone.`, label: 'Delete', danger: true,
    run: async () => {
      try { await api.delete(`/channels/${channelId}/studio/versions/${v.id}`); void loadVersions(); }
      catch { toast('Could not delete the version.', 'error'); }
    },
  });

  const toggleCompare = async (v: StudioVersionInfo) => {
    if (compare?.id === v.id) { setCompare(null); return; }
    setBusy(`cmp:${v.id}`);
    try {
      const res = await api.get<StudioDoc>(`/channels/${channelId}/studio/versions/${v.id}`);
      setCompare({ id: v.id, lines: diffDocs(res.data, useStudioStore.getState().doc ?? doc) });
    } catch { toast('Could not load that version.', 'error'); }
    finally { setBusy(null); }
  };

  return (
    <div className="studio-history">
      <section className="studio-history-col">
        <div className="studio-panel-toolbar">
          <span className="studio-panel-title">🕘 Changes</span>
          <label className="studio-check" title="Hide your own changes">
            <input type="checkbox" checked={onlyOthers} onChange={(e) => setOnlyOthers(e.target.checked)} />
            Others only
          </label>
          <div className="studio-spacer" />
          <button className="studio-btn small" onClick={() => void loadHistory()} title="Refresh">↻</button>
        </div>
        <div className="studio-history-list">
          {groups.length === 0 && <div className="studio-message small">No changes recorded yet. Every edit from now on shows up here, with who made it.</div>}
          {groups.map((g) => {
            const fresh = g.userId !== myId && g.changes[0].id > seenAtOpen.current;
            const open = expanded === g.key;
            return (
              <div key={g.key} className={`studio-history-item${fresh ? ' fresh' : ''}`}>
                <span className="studio-history-dot" style={{ background: colorForUser(g.userId) }} />
                <div className="studio-history-body">
                  <div className="studio-history-head">
                    <strong>{g.userId === myId ? 'You' : memberName(g.userId)}</strong>
                    <span className="studio-muted" title={new Date(g.start).toLocaleString()}>{ago(g.start)}</span>
                    {fresh && <span className="studio-history-new">new</span>}
                    {g.changes.length > 1 && (
                      <button className="studio-history-more" onClick={() => setExpanded(open ? null : g.key)}>
                        {g.changes.length} edits {open ? '▴' : '▾'}
                      </button>
                    )}
                  </div>
                  <div className="studio-history-summary">{g.kind === 'restore' ? `⏪ ${g.changes[0].summary}` : groupSummary(g)}</div>
                  {open && (
                    <ul className="studio-history-sub">
                      {g.changes.map((c) => {
                        const one: Group = { key: `c${c.id}`, userId: g.userId, kind: c.kind, changes: [c], start: c.createdAt, end: c.createdAt };
                        return (
                          <li key={c.id}>
                            <span className="studio-muted">{new Date(c.createdAt).toLocaleTimeString()}</span> {c.summary}
                            {editable && c.kind === 'edit' && (
                              <button className="studio-history-sub-revert" disabled={busy === one.key} onClick={() => void revert(one)} title="Revert just this edit">
                                {busy === one.key ? '…' : 'revert'}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                {editable && g.kind === 'edit' && (
                  <button className="studio-btn small" disabled={busy === g.key} onClick={() => void revert(g)}
                    title="Undo this change (works for anyone's change; you can Ctrl+Z the revert)">
                    {busy === g.key ? '…' : 'Revert'}
                  </button>
                )}
              </div>
            );
          })}
          {hasMore && <button className="studio-btn small studio-history-loadmore" onClick={() => void loadMore()}>Load older</button>}
        </div>
      </section>

      <section className="studio-history-col versions">
        <div className="studio-panel-toolbar">
          <span className="studio-panel-title">📌 Versions</span>
          <span className="studio-muted">auto-saved every 30 min while you work</span>
        </div>
        {editable && (
          <form className="studio-history-save" onSubmit={(e) => { e.preventDefault(); void saveVersion(); }}>
            <input className="studio-input" value={name} maxLength={80} placeholder="Name this version (e.g. “chorus v2”)" onChange={(e) => setName(e.target.value)} />
            <button className="studio-btn small on" type="submit" disabled={!name.trim() || busy === 'save'}>Save version</button>
          </form>
        )}
        <div className="studio-history-list">
          {versions.length === 0 && <div className="studio-message small">No versions yet.</div>}
          {versions.map((v) => (
            <div key={v.id} className="studio-history-version">
              <div className="studio-history-item">
                <span className="studio-history-icon">{v.auto ? '🕘' : '📌'}</span>
                <div className="studio-history-body">
                  <div className="studio-history-head">
                    <strong>{v.auto ? (v.name === 'Auto-save' ? 'Auto-save' : v.name) : v.name}</strong>
                    <span className="studio-muted" title={new Date(v.createdAt).toLocaleString()}>{ago(v.createdAt)}</span>
                  </div>
                  {v.createdById && <div className="studio-muted studio-history-summary">by {v.createdById === myId ? 'you' : memberName(v.createdById)}</div>}
                </div>
                <div className="studio-history-actions">
                  <button className={`studio-btn small${compare?.id === v.id ? ' on' : ''}`} disabled={busy === `cmp:${v.id}`} onClick={() => void toggleCompare(v)} title="What changed since this version">Compare</button>
                  {editable && <button className="studio-btn small" onClick={() => void restore(v)}>Restore</button>}
                  {editable && (v.createdById === myId || canManage) && <button className="studio-btn small" onClick={() => remove(v)} title="Delete version">✕</button>}
                </div>
              </div>
              {compare?.id === v.id && (
                <ul className="studio-history-diff">
                  <li className="studio-muted">Since this version:</li>
                  {compare.lines.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onConfirm={async () => { const run = confirm.run; setConfirm(null); await run(); }}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
