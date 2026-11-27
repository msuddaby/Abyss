import { useState } from 'react';
import type { StudioEffectType } from '@abyss/shared';
import { EFFECT_DEFS, type Resolved, type KnobDef, type ChoiceDef } from '../engine/effects';
import type { StudioEngine } from '../engine/StudioEngine';
import Knob from './Knob';
import { useCanvasLoop, drawFreqGrid, drawSpectrum } from './spectrum';

interface Props {
  type: StudioEffectType;
  params: Resolved;
  editable: boolean;
  engine: StudioEngine | null;
  trackId: string;
  fxId: string;
  color: string;
  onPreview: (p: Resolved) => void;
  onCommit: (p: Resolved) => void;
}

function Spectrum({ engine, trackId, fxId, color }: { engine: StudioEngine | null; trackId: string; fxId: string; color: string }) {
  const ref = useCanvasLoop((ctx, w, h) => {
    drawFreqGrid(ctx, w, h);
    const analyser = engine?.getEffectAnalyser(trackId, fxId);
    if (analyser && engine) drawSpectrum(ctx, analyser.getValue() as Float32Array, engine.sampleRate, w, h, color);
  });
  return <canvas ref={ref} className="studio-device-spectrum" />;
}

/** Static transfer curve (in → out dB) plus a live gain-reduction meter. */
function CompressorDisplay({ p, engine, trackId, fxId, color }: { p: Resolved; engine: StudioEngine | null; trackId: string; fxId: string; color: string }) {
  const ref = useCanvasLoop((ctx, w, h) => {
    const meterW = 10;
    const gw = w - meterW - 6;
    const lo = -60;
    const toX = (db: number) => ((db - lo) / -lo) * gw;
    const toY = (db: number) => h - ((Math.min(0, Math.max(lo, db)) - lo) / -lo) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let db = -48; db < 0; db += 12) {
      ctx.beginPath(); ctx.moveTo(toX(db), 0); ctx.lineTo(toX(db), h); ctx.moveTo(0, toY(db)); ctx.lineTo(gw, toY(db)); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.moveTo(toX(lo), toY(lo)); ctx.lineTo(toX(0), toY(0)); ctx.stroke();

    const { threshold, ratio, knee, makeup } = p as Record<string, number>;
    const out = (x: number) => {
      const over = x - threshold;
      if (2 * over < -knee) return x;
      if (knee > 0 && 2 * Math.abs(over) <= knee) return x + ((1 / ratio - 1) * (over + knee / 2) ** 2) / (2 * knee);
      return threshold + over / ratio;
    };
    ctx.beginPath();
    for (let i = 0; i <= gw; i++) {
      const x = lo + (i / gw) * -lo;
      const y = toY(out(x) + makeup);
      if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    // threshold marker
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(toX(threshold), 0); ctx.lineTo(toX(threshold), h); ctx.stroke();
    ctx.setLineDash([]);

    // GR meter (grows downward)
    const gr = Math.min(0, engine?.getEffectReduction(trackId, fxId) ?? 0);
    const mx = w - meterW;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(mx, 0, meterW, h);
    ctx.fillStyle = '#ffb347';
    ctx.fillRect(mx, 0, meterW, Math.min(h, (-gr / 24) * h));
  });
  return <canvas ref={ref} className="studio-device-transfer" title="Transfer curve · gain reduction" />;
}

export default function EffectDevice({ type, params, editable, engine, trackId, fxId, color, onPreview, onCommit }: Props) {
  const def = EFFECT_DEFS[type];
  const [draft, setDraft] = useState<Resolved | null>(null);
  const p = draft ?? params;
  const visible = def.params.filter((d) => !d.when || d.when(p));
  const choices = visible.filter((d): d is ChoiceDef => d.kind === 'choice');
  const knobs = visible.filter((d): d is KnobDef => d.kind === 'knob');

  const preview = (next: Resolved) => { setDraft(next); onPreview(next); };
  const commit = (next: Resolved) => { setDraft(null); onCommit(next); };

  return (
    <div className="studio-device-body">
      <div className="studio-device-display">
        <Spectrum engine={engine} trackId={trackId} fxId={fxId} color={color} />
        {type === 'compressor' && <CompressorDisplay p={p} engine={engine} trackId={trackId} fxId={fxId} color={color} />}
      </div>
      {choices.length > 0 && (
        <div className="studio-device-choices">
          {choices.map((c) => (
            <div key={c.key} className="studio-seg" title={c.label}>
              {c.options.map((o) => (
                <button
                  key={o.value}
                  className={`studio-seg-btn${String(p[c.key]) === o.value ? ' on' : ''}`}
                  disabled={!editable}
                  onClick={() => commit({ ...params, [c.key]: o.value })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="studio-device-knobs">
        {knobs.map((k) => (
          <Knob
            key={k.key}
            label={k.label}
            value={Number(p[k.key])}
            min={k.min}
            max={k.max}
            def={k.def}
            unit={k.unit}
            log={k.log}
            color={color}
            disabled={!editable}
            onPreview={(v) => preview({ ...params, [k.key]: v })}
            onCommit={(v) => commit({ ...params, [k.key]: v })}
          />
        ))}
      </div>
    </div>
  );
}
