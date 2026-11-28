import { useState } from 'react';
import { useStudioStore } from '@abyss/shared';
import { DELAY_DIVISIONS, delaySideSeconds, type Resolved } from '../engine/effects';
import Knob from './Knob';

// Ableton-style Delay: an independent left and right line, each either synced
// (16th-note divisions with a swing offset) or free in ms. Link drives both
// sides from the left controls; ping pong bounces repeats L → R → L.

interface Props {
  params: Resolved;
  editable: boolean;
  color: string;
  onPreview: (p: Resolved) => void;
  onCommit: (p: Resolved) => void;
}

type Side = 'l' | 'r';

/** Where each echo lands (in beats) and how loud it is, per side. */
function taps(p: Resolved, bpm: number, horizon: number) {
  const beat = 60 / bpm;
  const tl = delaySideSeconds(p, 'l', bpm) / beat;
  const tr = delaySideSeconds(p, 'r', bpm) / beat;
  const fb = p.freeze === true ? 1 : Math.min(0.95, Number(p.feedback) / 100);
  const out: { side: Side; at: number; amp: number }[] = [];
  if (p.mode === 'pingpong') {
    let at = 0, amp = 1;
    for (let i = 0; i < 64 && amp > 0.02; i++) {
      at += tl; if (at > horizon) break; out.push({ side: 'l', at, amp });
      at += tr; if (at > horizon) break; out.push({ side: 'r', at, amp });
      amp *= fb;
    }
  } else {
    for (const [side, t] of [['l', tl], ['r', tr]] as const) {
      let amp = 1;
      for (let k = 1; k * t <= horizon && amp > 0.02 && k < 64; k++, amp *= fb) out.push({ side, at: k * t, amp });
    }
  }
  return out;
}

function TapDisplay({ p, bpm, color }: { p: Resolved; bpm: number; color: string }) {
  const horizon = 8; // two bars of 4/4
  const W = 400, H = 48, mid = H / 2;
  const x = (beat: number) => (beat / horizon) * W;
  return (
    <svg className="studio-delay-display" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      {Array.from({ length: horizon * 4 + 1 }, (_, i) => (
        <line key={i} x1={x(i / 4)} x2={x(i / 4)} y1={0} y2={H}
          stroke={i % 4 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)'} />
      ))}
      <line x1={0} x2={W} y1={mid} y2={mid} stroke="rgba(255,255,255,0.12)" />
      <text x={3} y={10} className="studio-delay-display-label">L</text>
      <text x={3} y={H - 3} className="studio-delay-display-label">R</text>
      <rect x={0} y={2} width={3} height={H - 4} fill="rgba(255,255,255,0.5)" />
      {taps(p, bpm, horizon).map((t, i) => {
        const h = Math.max(1.5, t.amp * (mid - 3));
        return (
          <rect key={i} x={x(t.at) - 1.5} width={3} rx={1}
            y={t.side === 'l' ? mid - h : mid} height={h}
            fill={color} opacity={0.35 + 0.65 * t.amp} />
        );
      })}
    </svg>
  );
}

export default function DelayDevice({ params, editable, color, onPreview, onCommit }: Props) {
  const bpm = useStudioStore((s) => s.doc?.meta.bpm ?? 120);
  const [draft, setDraft] = useState<Resolved | null>(null);
  const p = draft ?? params;
  const linked = p.link === true;

  const preview = (patch: Resolved) => { const next = { ...params, ...patch }; setDraft(next); onPreview(next); };
  const commit = (patch: Resolved) => { setDraft(null); onCommit({ ...params, ...patch }); };

  /** Toggling link copies the left settings across so nothing jumps. */
  const toggleLink = () => {
    if (linked) commit({ link: false, rSync: p.lSync, rDiv: p.lDiv, rOff: p.lOff, rMs: p.lMs });
    else commit({ link: true });
  };

  const side = (s: Side) => {
    // Linked: the right side mirrors the left and is read-only.
    const src: Side = linked ? 'l' : s;
    const locked = !editable || (linked && s === 'r');
    const synced = p[`${src}Sync`] !== false;
    const div = Number(p[`${src}Div`]);
    return (
      <div className={`studio-delay-side${linked && s === 'r' ? ' linked' : ''}`}>
        <div className="studio-delay-side-head">
          <span className="studio-delay-side-name">{s === 'l' ? 'L' : 'R'}</span>
          <div className="studio-seg">
            <button className={`studio-seg-btn${synced ? ' on' : ''}`} disabled={locked} onClick={() => commit({ [`${s}Sync`]: true })} title="Sync to tempo">Sync</button>
            <button className={`studio-seg-btn${!synced ? ' on' : ''}`} disabled={locked} onClick={() => commit({ [`${s}Sync`]: false })} title="Free time in milliseconds">ms</button>
          </div>
        </div>
        {synced ? (
          <>
            <div className="studio-delay-divs" title="Delay time in 16th notes">
              {DELAY_DIVISIONS.map((d) => (
                <button key={d} className={`studio-seg-btn${div === d ? ' on' : ''}`} disabled={locked} onClick={() => commit({ [`${s}Div`]: d })}>
                  {d}
                </button>
              ))}
            </div>
            <Knob label="Offset" value={Number(p[`${src}Off`])} min={-33} max={33} def={0} unit="%" color={color} disabled={locked} size={34}
              onPreview={(v) => preview({ [`${s}Off`]: v })} onCommit={(v) => commit({ [`${s}Off`]: v })} />
          </>
        ) : (
          <Knob label="Time" value={Number(p[`${src}Ms`])} min={1} max={5000} def={250} unit="ms" log color={color} disabled={locked}
            onPreview={(v) => preview({ [`${s}Ms`]: v })} onCommit={(v) => commit({ [`${s}Ms`]: v })} />
        )}
      </div>
    );
  };

  const toggle = (key: string, label: string, title: string) => (
    <button className={`studio-delay-toggle${p[key] === true ? ' on' : ''}`} disabled={!editable} onClick={() => commit({ [key]: p[key] !== true })} title={title}>
      {label}
    </button>
  );

  const knob = (key: string, label: string, min: number, max: number, def: number, unit: 'Hz' | '%' | 'octw', log = false, disabled = false) => (
    <Knob label={label} value={Number(p[key])} min={min} max={max} def={def} unit={unit} log={log} color={color} disabled={!editable || disabled}
      onPreview={(v) => preview({ [key]: v })} onCommit={(v) => commit({ [key]: v })} />
  );

  return (
    <div className="studio-device-body studio-delay">
      <TapDisplay p={p} bpm={bpm} color={color} />
      <div className="studio-delay-main">
        {side('l')}
        <button className={`studio-delay-link${linked ? ' on' : ''}`} disabled={!editable} onClick={toggleLink}
          title={linked ? 'Unlink: set left and right separately' : 'Link: right follows left'}>
          {linked ? '🔗' : '⛓️‍💥'}
        </button>
        {side('r')}
        <div className="studio-delay-sep" />
        <div className="studio-delay-knobs">
          {knob('feedback', 'Feedback', 0, 95, 35, '%', false, p.freeze === true)}
          {knob('mix', 'Dry/Wet', 0, 100, 25, '%')}
          {knob('fFreq', 'Freq', 50, 18000, 1000, 'Hz', true, p.filterOn !== true)}
          {knob('fWidth', 'Width', 0.5, 9, 6, 'octw', false, p.filterOn !== true)}
        </div>
        <div className="studio-delay-toggles">
          {toggle('filterOn', 'Filter', 'Band-pass inside the feedback loop: each repeat gets thinner')}
          <button className={`studio-delay-toggle${p.mode === 'pingpong' ? ' on' : ''}`} disabled={!editable}
            onClick={() => commit({ mode: p.mode === 'pingpong' ? 'stereo' : 'pingpong' })} title="Bounce repeats between left and right">
            Ping Pong
          </button>
          {toggle('freeze', 'Freeze', 'Loop what is in the delay forever and ignore new input')}
        </div>
      </div>
    </div>
  );
}
