import { useEffect, useMemo, useRef, useState } from 'react';
import type { StudioParams } from '@abyss/shared';
import type { StudioEngine } from '../engine/StudioEngine';
import { TABLES, FRAMES, frameSamples, morphSamples } from '../engine/wavetable/wavetables';
import {
  resolveSynthParams, presetParams, SYNTH_PRESETS, MOD_SLOTS, MOD_SOURCES, MOD_TARGETS, FILTER_TYPES, LFO_SHAPES, LFO_SYNC,
  type SynthParams,
} from '../engine/wavetable/synthParams';
import type { ParamUnit } from '../engine/effects';
import Knob from './Knob';
import CommitSlider from '../CommitSlider';
import { useCanvasLoop, freqToX, xToFreq, drawFreqGrid } from './spectrum';

interface Props {
  trackId: string;
  params: StudioParams | undefined;
  editable: boolean;
  engine: StudioEngine | null;
  color: string;
  /** Live values while a control moves (automation recording) */
  onPreviewParams?: (params: StudioParams) => void;
  onCommit: (params: StudioParams) => void;
}

type Tab = 'osc' | 'mod' | 'matrix';
const OSC_COLORS = { a: '#38bdf8', b: '#f472b6' };
const KNOB = 32;

function storable(p: SynthParams): StudioParams {
  const out: StudioParams = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  return out;
}

// ───────────────────────── Displays ─────────────────────────

/** Pseudo-3D stack of wavetable frames with the current position highlighted. */
function WavetableView({ table, pos, color, on }: { table: string; pos: number; color: string; on: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frames = useMemo(() => Array.from({ length: FRAMES }, (_, f) => frameSamples(table, f, 96)), [table]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#101114';
    ctx.fillRect(0, 0, w, h);
    const depthX = 40, depthY = 22;
    const fw = w - depthX - 8, fh = (h - depthY - 8) / 2;
    const draw = (data: Float32Array, f: number, style: string, lw: number) => {
      const ox = 4 + (f / (FRAMES - 1)) * depthX, oy = 4 + depthY - (f / (FRAMES - 1)) * depthY + fh;
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = ox + (i / (data.length - 1)) * fw, y = oy - data[i] * fh * 0.9;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = lw;
      ctx.stroke();
    };
    for (let f = FRAMES - 1; f >= 0; f--) draw(frames[f], f, 'rgba(255,255,255,0.10)', 1);
    draw(morphSamples(table, pos, 160), pos * (FRAMES - 1), on ? color : 'rgba(255,255,255,0.35)', 2);
  }, [frames, table, pos, color, on]);
  return <canvas ref={ref} className="studio-synth-wt" />;
}

/** Analytic response of the state-variable filter (matches the worklet). */
function FilterView({ type, cutoff, res, on, editable, onPreview, onCommit }: {
  type: string; cutoff: number; res: number; on: boolean; editable: boolean;
  onPreview: (cutoff: number, res: number) => void; onCommit: (cutoff: number, res: number) => void;
}) {
  const latest = { type, cutoff, res, on };
  const ref = useCanvasLoop((ctx, w, h) => {
    drawFreqGrid(ctx, w, h, false);
    const { type, cutoff, res, on } = latest;
    const k = 2 - 1.96 * res;
    const stages = type === 'lp24' || type === 'hp24' ? 2 : 1;
    const yOf = (db: number) => h * 0.35 - (db / 30) * h * 0.6;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const r = xToFreq(x, w) / cutoff, r2 = r * r;
      const den = Math.sqrt((1 - r2) ** 2 + (k * r) ** 2);
      let mag: number;
      switch (type) {
        case 'hp12': case 'hp24': mag = r2 / den; break;
        case 'bp': mag = (k * r) / den; break;
        case 'notch': mag = Math.abs(1 - r2) / den; break;
        default: mag = 1 / den;
      }
      const db = on ? 20 * Math.log10(Math.max(1e-5, mag)) * stages : 0;
      const y = Math.min(h, Math.max(0, yOf(db)));
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = on ? '#ffb347' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    const cx = freqToX(cutoff, w);
    ctx.fillStyle = on ? '#ffb347' : 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.arc(cx, yOf(on ? 20 * Math.log10(1 / Math.max(0.04, k)) * stages : 0), 4, 0, Math.PI * 2); ctx.fill();
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (!editable || e.button !== 0) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => ({
      c: Math.round(Math.min(20000, Math.max(20, xToFreq(ev.clientX - rect.left, rect.width)))),
      r: Math.round(Math.min(1, Math.max(0, 1 - (ev.clientY - rect.top) / rect.height)) * 100) / 100,
    });
    let last = at(e);
    onPreview(last.c, last.r);
    const move = (ev: PointerEvent) => { last = at(ev); onPreview(last.c, last.r); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onCommit(last.c, last.r); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <canvas ref={ref} className="studio-synth-filter-view" onPointerDown={onPointerDown} title={editable ? 'Drag: left/right = cutoff, up/down = resonance' : undefined} />;
}

export function EnvView({ a, d, s, r, color }: { a: number; d: number; s: number; r: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const seg = (t: number) => Math.log10(1 + t * 20) / Math.log10(1 + 4 * 20); // log-ish time
    const total = seg(a) + seg(d) + 0.35 + seg(r);
    const sx = (w - 8) / Math.max(1e-3, total);
    const y = (v: number) => h - 4 - v * (h - 8);
    let x = 4;
    ctx.beginPath();
    ctx.moveTo(x, y(0));
    x += seg(a) * sx; ctx.lineTo(x, y(1));
    const steps = 16, x0 = x, dw = seg(d) * sx;
    for (let i = 1; i <= steps; i++) ctx.lineTo(x0 + (i / steps) * dw, y(s + (1 - s) * Math.exp(-4.6 * i / steps)));
    x = x0 + dw;
    ctx.lineTo(x + 0.35 * sx, y(s));
    x += 0.35 * sx;
    const x1 = x, rw = seg(r) * sx;
    for (let i = 1; i <= steps; i++) ctx.lineTo(x1 + (i / steps) * rw, y(s * Math.exp(-4.6 * i / steps)));
    ctx.lineTo(x1 + rw, y(0));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(4, y(0));
    ctx.fillStyle = `${color}22`;
    ctx.fill();
  }, [a, d, s, r, color]);
  return <canvas ref={ref} className="studio-synth-env-view" />;
}

function LfoView({ shape, color }: { shape: string; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const val = (p: number, i: number) => {
      switch (shape) {
        case 'tri': return 1 - 4 * Math.abs(p - 0.5);
        case 'saw': return 1 - 2 * p;
        case 'ramp': return 2 * p - 1;
        case 'square': return p < 0.5 ? 1 : -1;
        case 'sh': return [0.6, -0.3, 0.9, -0.8, 0.1, -0.5, 0.4, -0.1][Math.floor(i / 8) % 8];
        default: return Math.sin(2 * Math.PI * p);
      }
    };
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const x = 4 + (i / 64) * (w - 8), y = h / 2 - val((i / 64) % 1, i) * (h / 2 - 5);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [shape, color]);
  return <canvas ref={ref} className="studio-synth-env-view" />;
}

export function Scope({ engine, trackId, color }: { engine: StudioEngine | null; trackId: string; color: string }) {
  const ref = useCanvasLoop((ctx, w, h) => {
    const data = engine?.getInstrumentAnalyser(trackId)?.getValue() as Float32Array | undefined;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    if (!data) return;
    // Trigger on a rising zero crossing so the trace stands still.
    let start = 0;
    for (let i = 1; i < data.length / 2; i++) if (data[i - 1] < 0 && data[i] >= 0) { start = i; break; }
    const n = Math.min(data.length - start, 512);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w, y = h / 2 - Math.max(-1, Math.min(1, data[start + i])) * (h / 2 - 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.stroke();
  });
  return <canvas ref={ref} className="studio-synth-scope" title="Output" />;
}

// ───────────────────────── Device ─────────────────────────

export default function SynthDevice({ trackId, params, editable, engine, color, onPreviewParams, onCommit }: Props) {
  const [tab, setTab] = useState<Tab>('osc');
  const [draft, setDraft] = useState<SynthParams | null>(null);
  const base = useMemo(() => resolveSynthParams(params), [params]);
  const p = draft ?? base;
  const n = (k: string) => Number(p[k] ?? 0);
  const s = (k: string) => String(p[k] ?? '');
  const b = (k: string) => p[k] === true;

  const preview = (patch: SynthParams) => {
    const next = { ...base, ...patch };
    setDraft(next);
    engine?.previewInstrument(trackId, storable(next));
    onPreviewParams?.(storable(next));
  };
  const commit = (patch: SynthParams) => {
    setDraft(null);
    onCommit(storable({ ...base, ...patch }));
  };

  /** Knob bound to a param; `scale` maps stored→shown (e.g. 0..1 → %) */
  const K = (key: string, label: string, min: number, max: number, def: number, unit: ParamUnit, opts: { log?: boolean; integer?: boolean; scale?: number; c?: string; off?: boolean } = {}) => {
    const scale = opts.scale ?? 1;
    return (
      <Knob
        key={key}
        label={label}
        value={n(key) * scale}
        min={min}
        max={max}
        def={def * scale}
        unit={unit}
        log={opts.log}
        integer={opts.integer}
        size={KNOB}
        color={opts.c ?? color}
        disabled={!editable || opts.off}
        onPreview={(v) => preview({ [key]: v / scale })}
        onCommit={(v) => commit({ [key]: v / scale })}
      />
    );
  };

  const toggle = (k: string, title: string) => (
    <button className={`studio-device-power${b(k) ? ' on' : ''}`} disabled={!editable} onClick={() => commit({ [k]: !b(k) })} title={title} />
  );

  const seg = (k: string, options: readonly { value: string | number; label: string }[]) => (
    <div className="studio-seg">
      {options.map((o) => (
        <button key={String(o.value)} className={`studio-seg-btn${String(p[k]) === String(o.value) ? ' on' : ''}`} disabled={!editable}
          onClick={() => commit({ [k]: o.value })}>{o.label}</button>
      ))}
    </div>
  );

  const osc = (x: 'a' | 'b') => {
    const c = OSC_COLORS[x];
    const on = b(`${x}On`);
    return (
      <div className={`studio-synth-panel osc${on ? '' : ' off'}`} style={{ ['--device-color' as string]: c }}>
        <div className="studio-synth-panel-head">
          {toggle(`${x}On`, on ? 'Turn oscillator off' : 'Turn oscillator on')}
          <span className="studio-synth-panel-title" style={{ color: c }}>OSC {x.toUpperCase()}</span>
          <select className="studio-select small" value={s(`${x}Wt`)} disabled={!editable} onChange={(e) => commit({ [`${x}Wt`]: e.target.value })} title="Wavetable">
            {TABLES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <WavetableView table={s(`${x}Wt`)} pos={n(`${x}Pos`)} color={c} on={on} />
        <div className="studio-device-knobs">
          {K(`${x}Pos`, 'WT Pos', 0, 100, 0, '%', { scale: 100, c })}
          {K(`${x}Uni`, 'Unison', 1, 8, 1, 'x', { integer: true, c })}
          {K(`${x}Det`, 'Detune', 0, 100, 0.25, '%', { scale: 100, c })}
          {K(`${x}Blend`, 'Blend', 0, 100, 0.75, '%', { scale: 100, c })}
          {K(`${x}Width`, 'Width', 0, 100, 0.8, '%', { scale: 100, c })}
          {K(`${x}Oct`, 'Oct', -3, 3, 0, 'oct', { integer: true, c })}
          {K(`${x}Semi`, 'Semi', -12, 12, 0, 'st', { integer: true, c })}
          {K(`${x}Fine`, 'Fine', -100, 100, 0, 'ct', { c })}
          {K(`${x}Pan`, 'Pan', -100, 100, 0, '%', { scale: 100, c })}
          {K(`${x}Level`, 'Level', 0, 100, 0.75, '%', { scale: 100, c })}
        </div>
      </div>
    );
  };

  const env = (i: 1 | 2 | 3, label: string, c: string) => (
    <div className="studio-synth-panel env">
      <div className="studio-synth-panel-head"><span className="studio-synth-panel-title" style={{ color: c }}>{label}</span></div>
      <EnvView a={n(`e${i}a`)} d={n(`e${i}d`)} s={n(`e${i}s`)} r={n(`e${i}r`)} color={c} />
      <div className="studio-device-knobs">
        {K(`e${i}a`, 'Attack', 0.001, 8, 0.005, 's', { log: true, c })}
        {K(`e${i}d`, 'Decay', 0.005, 8, 0.4, 's', { log: true, c })}
        {K(`e${i}s`, 'Sustain', 0, 100, 0.75, '%', { scale: 100, c })}
        {K(`e${i}r`, 'Release', 0.005, 12, 0.3, 's', { log: true, c })}
      </div>
    </div>
  );

  const lfo = (i: 1 | 2, c: string) => {
    const sync = b(`l${i}Sync`);
    return (
      <div className="studio-synth-panel env">
        <div className="studio-synth-panel-head">
          <span className="studio-synth-panel-title" style={{ color: c }}>LFO {i}</span>
          <select className="studio-select small" value={s(`l${i}Shape`)} disabled={!editable} onChange={(e) => commit({ [`l${i}Shape`]: e.target.value })}>
            {LFO_SHAPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <LfoView shape={s(`l${i}Shape`)} color={c} />
        <div className="studio-device-choices">
          <div className="studio-seg">
            <button className={`studio-seg-btn${!sync ? ' on' : ''}`} disabled={!editable} onClick={() => commit({ [`l${i}Sync`]: false })}>Hz</button>
            <button className={`studio-seg-btn${sync ? ' on' : ''}`} disabled={!editable} onClick={() => commit({ [`l${i}Sync`]: true })}>Sync</button>
          </div>
          <button className={`studio-seg-btn standalone${b(`l${i}Retrig`) ? ' on' : ''}`} disabled={!editable} onClick={() => commit({ [`l${i}Retrig`]: !b(`l${i}Retrig`) })}
            title="Restart the LFO on every note">Retrig</button>
        </div>
        <div className="studio-device-knobs">
          {sync ? (
            <select className="studio-select small" value={n(`l${i}Div`)} disabled={!editable} onChange={(e) => commit({ [`l${i}Div`]: Number(e.target.value) })} title="Rate">
              {LFO_SYNC.map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}
            </select>
          ) : K(`l${i}Rate`, 'Rate', 0.02, 30, 1, 'Hz', { log: true, c })}
        </div>
      </div>
    );
  };

  return (
    <div className="studio-device-body studio-synth">
      <div className="studio-synth-top">
        <select
          className="studio-select small studio-synth-preset"
          value={SYNTH_PRESETS.some((x) => x.name === s('preset')) ? s('preset') : ''}
          disabled={!editable}
          onChange={(e) => { if (e.target.value) { setDraft(null); onCommit(storable(presetParams(e.target.value))); } }}
          title="Preset"
        >
          {!SYNTH_PRESETS.some((x) => x.name === s('preset')) && <option value="">Custom</option>}
          {SYNTH_PRESETS.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
        <div className="studio-synth-tabs">
          {(['osc', 'mod', 'matrix'] as Tab[]).map((t) => (
            <button key={t} className={`studio-synth-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{t.toUpperCase()}</button>
          ))}
        </div>
        <Scope engine={engine} trackId={trackId} color={color} />
        <div className="studio-synth-voicing">
          <label title="Voices (1 = mono with legato glide)">
            Voices
            <select className="studio-select small" value={n('poly')} disabled={!editable} onChange={(e) => commit({ poly: Number(e.target.value) })}>
              {[1, 2, 4, 6, 8, 12, 16].map((v) => <option key={v} value={v}>{v === 1 ? 'Mono' : v}</option>)}
            </select>
          </label>
          {K('glide', 'Glide', 0, 1, 0, 's')}
          {K('volume', 'Master', -36, 6, -6, 'dB')}
        </div>
      </div>

      {tab === 'osc' && (
        <div className="studio-synth-row">
          {osc('a')}
          {osc('b')}
          <div className="studio-synth-panel narrow">
            <div className="studio-synth-panel-head"><span className="studio-synth-panel-title">SUB</span></div>
            <div className="studio-device-choices">
              {seg('subShape', [{ value: 'sine', label: 'Sin' }, { value: 'tri', label: 'Tri' }, { value: 'square', label: 'Sqr' }])}
            </div>
            <div className="studio-device-knobs">
              {K('subOct', 'Oct', -2, 0, -1, 'oct', { integer: true })}
              {K('subLevel', 'Level', 0, 100, 0, '%', { scale: 100 })}
            </div>
            <div className="studio-synth-panel-head"><span className="studio-synth-panel-title">NOISE</span></div>
            <div className="studio-device-knobs">{K('noiseLevel', 'Level', 0, 100, 0, '%', { scale: 100 })}</div>
          </div>
          <div className={`studio-synth-panel filter${b('fOn') ? '' : ' off'}`}>
            <div className="studio-synth-panel-head">
              {toggle('fOn', b('fOn') ? 'Bypass filter' : 'Enable filter')}
              <span className="studio-synth-panel-title">FILTER</span>
              <select className="studio-select small" value={s('fType')} disabled={!editable} onChange={(e) => commit({ fType: e.target.value })}>
                {FILTER_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <FilterView
              type={s('fType')} cutoff={n('fCutoff')} res={n('fRes')} on={b('fOn')} editable={editable}
              onPreview={(c, r) => preview({ fCutoff: c, fRes: r })}
              onCommit={(c, r) => commit({ fCutoff: c, fRes: r })}
            />
            <div className="studio-device-knobs">
              {K('fCutoff', 'Cutoff', 20, 20000, 9000, 'Hz', { log: true })}
              {K('fRes', 'Res', 0, 100, 0.15, '%', { scale: 100 })}
              {K('fDrive', 'Drive', 0, 100, 0, '%', { scale: 100 })}
              {K('fKey', 'Key Trk', 0, 100, 0, '%', { scale: 100 })}
            </div>
          </div>
        </div>
      )}

      {tab === 'mod' && (
        <div className="studio-synth-row">
          {env(1, 'ENV 1 · AMP', '#4ade80')}
          {env(2, 'ENV 2', '#facc15')}
          {env(3, 'ENV 3', '#fb923c')}
          {lfo(1, '#a78bfa')}
          {lfo(2, '#2dd4bf')}
        </div>
      )}

      {tab === 'matrix' && (
        <div className="studio-synth-matrix">
          {Array.from({ length: MOD_SLOTS }, (_, i) => {
            const amt = n(`m${i}amt`);
            const active = s(`m${i}src`) && s(`m${i}dst`) && amt !== 0;
            return (
              <div key={i} className={`studio-synth-mod${active ? ' active' : ''}`}>
                <span className="studio-synth-mod-n">{i + 1}</span>
                <select className="studio-select small" value={s(`m${i}src`)} disabled={!editable} onChange={(e) => commit({ [`m${i}src`]: e.target.value })}>
                  <option value="">— source —</option>
                  {MOD_SOURCES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <span className="studio-synth-mod-arrow">→</span>
                <select className="studio-select small" value={s(`m${i}dst`)} disabled={!editable} onChange={(e) => commit({ [`m${i}dst`]: e.target.value })}>
                  <option value="">— destination —</option>
                  {MOD_TARGETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <CommitSlider
                  className="studio-slider studio-synth-mod-amt"
                  min={-1} max={1} step={0.01}
                  value={amt}
                  resetValue={0}
                  disabled={!editable}
                  title="Amount (double-click to zero)"
                  onPreview={(v) => preview({ [`m${i}amt`]: v })}
                  onCommit={(v) => commit({ [`m${i}amt`]: v })}
                />
                <span className="studio-synth-mod-val">{amt > 0 ? '+' : ''}{Math.round(amt * 100)}%</span>
              </div>
            );
          })}
          <p className="studio-muted studio-synth-matrix-hint">
            Bipolar amounts. Cutoff modulates ±6 octaves, pitch ±24 semitones; levels, wavetable position, detune and pan move across their full range.
          </p>
        </div>
      )}
    </div>
  );
}
