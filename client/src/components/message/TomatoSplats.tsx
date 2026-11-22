import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { MessageSplat, TomatoAmmo } from "@abyss/shared";

// ─── Shape generation ────────────────────────────────────────────────────────
// Every client draws the same splat from the server-assigned seed.

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SplatShape {
  blob: string;
  highlight: string;
  droplets: { cx: number; cy: number; r: number }[];
  drips: { d: string; delay: number }[];
  seeds: { cx: number; cy: number; rot: number }[];
  rotation: number;
  /** Projectile launch offset (px), always from somewhere above. */
  fromX: number;
  fromY: number;
}

function smoothClosedPath(points: [number, number][]): string {
  const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const n = points.length;
  const start = mid(points[n - 1], points[0]);
  let d = `M${start[0].toFixed(1)},${start[1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const m = mid(p, points[(i + 1) % n]);
    d += `Q${p[0].toFixed(1)},${p[1].toFixed(1)} ${m[0].toFixed(1)},${m[1].toFixed(1)}`;
  }
  return d + "Z";
}

function blobPoints(rand: () => number, base: number, wobble: number, spikeChance: number) {
  const n = 16 + Math.floor(rand() * 6);
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.25;
    let r = base + rand() * wobble;
    if (rand() < spikeChance) r += 8 + rand() * 14; // splash spokes
    pts.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  return pts;
}

const shapeCache = new Map<number, SplatShape>();

function getShape(seed: number): SplatShape {
  const cached = shapeCache.get(seed);
  if (cached) return cached;
  const rand = mulberry32(seed);

  const blob = smoothClosedPath(blobPoints(rand, 19, 6, 0.3));
  const highlight = smoothClosedPath(
    blobPoints(rand, 6, 3, 0).map(([x, y]) => [x - 6, y - 7] as [number, number]),
  );

  const droplets = Array.from({ length: 5 + Math.floor(rand() * 5) }, () => {
    const a = rand() * Math.PI * 2;
    const dist = 32 + rand() * 20;
    return { cx: Math.cos(a) * dist, cy: Math.sin(a) * dist, r: 1.5 + rand() * 3.5 };
  });

  const drips = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => {
    const x = (rand() - 0.5) * 28;
    const w = 3 + rand() * 3;
    const top = 10;
    const len = 14 + rand() * 26;
    const bulb = w * 0.8;
    // Tapered column ending in a droplet bulb.
    const d =
      `M${x - w / 2},${top} L${x - w / 2},${top + len} ` +
      `A${bulb},${bulb} 0 1 0 ${x + w / 2},${top + len} L${x + w / 2},${top} Z`;
    return { d, delay: 0.5 + i * 0.35 + rand() * 0.4 };
  });

  const seeds = Array.from({ length: 3 + Math.floor(rand() * 4) }, () => {
    const a = rand() * Math.PI * 2;
    const dist = rand() * 12;
    return { cx: Math.cos(a) * dist, cy: Math.sin(a) * dist, rot: rand() * 180 };
  });

  // Launch from the upper half-circle (between 200° and 340°).
  const launch = ((200 + rand() * 140) * Math.PI) / 180;
  const shape: SplatShape = {
    blob,
    highlight,
    droplets,
    drips,
    seeds,
    rotation: rand() * 360,
    fromX: Math.cos(launch) * 280,
    fromY: Math.sin(launch) * 280,
  };
  shapeCache.set(seed, shape);
  return shape;
}

// ─── Aging ───────────────────────────────────────────────────────────────────
// Fresh (bright, glossy) → dried after a day (dull, darker) → faint stain by day 4.

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const x = (pa >> shift) & 0xff;
    const y = (pb >> shift) & 0xff;
    return Math.round(x + (y - x) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

function agePalette(createdAt: string) {
  const hours = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 3_600_000);
  const dry = Math.min(1, hours / 24);
  const fade = Math.min(1, Math.max(0, (hours - 24) / 72));
  return {
    fill: mixHex("#e3311f", "#7a2a1d", dry),
    opacity: 0.95 - 0.2 * dry - 0.5 * fade,
    gloss: 0.45 * (1 - dry),
    seedOpacity: 0.85 * (1 - fade),
  };
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── Sound ───────────────────────────────────────────────────────────────────
// Synthesised so there's no asset to ship: a lowpassed noise burst plus a thump.

let audioCtx: AudioContext | null = null;

function playSplatSound() {
  if (document.hidden) return;
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const dur = 0.35;

    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(2400, now);
    lp.frequency.exponentialRampToValueAtTime(280, now + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.3, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(lp).connect(ng).connect(ctx.destination);
    noise.start(now);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.15);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.35, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc.connect(og).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch {
    // Audio is a nicety; never let it break rendering.
  }
}

const IMPACT_DELAY_MS = 380;

// ─── Rendering ───────────────────────────────────────────────────────────────

const Splat = memo(function Splat({ splat, fresh }: { splat: MessageSplat; fresh: boolean }) {
  const shape = getShape(splat.seed);
  const style = {
    left: `${splat.x * 100}%`,
    top: `${splat.y * 100}%`,
    "--from-x": `${shape.fromX}px`,
    "--from-y": `${shape.fromY}px`,
  } as React.CSSProperties;

  if (splat.wipedAt) {
    return (
      <div className="tomato-splat tomato-smear" style={style} aria-hidden>
        <svg viewBox="-60 -60 120 150" width="84" height="105">
          <ellipse cx="0" cy="0" rx="30" ry="9" fill="#8a3a2a" transform={`rotate(${shape.rotation % 40 - 20})`} />
        </svg>
      </div>
    );
  }

  const pal = agePalette(splat.createdAt);
  return (
    <div className={`tomato-splat${fresh ? " fresh" : ""}`} style={style}>
      {fresh && (
        <div className="tomato-projectile" aria-hidden>
          <svg viewBox="-12 -14 24 26" width="26" height="28">
            <circle cx="0" cy="1" r="10" fill="#e3311f" />
            <ellipse cx="-3.5" cy="-2.5" rx="3" ry="2" fill="#ff8a70" opacity="0.7" />
            <path d="M0,-9 l-4,-3 l3,0.5 l1,-3 l1,3 l3,-0.5 z" fill="#3f9b3a" />
          </svg>
        </div>
      )}
      <svg className="tomato-splat-svg" viewBox="-60 -60 120 150" width="84" height="105" style={{ opacity: pal.opacity }}>
        <title>{`🍅 ${splat.displayName} · ${timeAgo(splat.createdAt)}`}</title>
        <g className="tomato-splat-drips">
          {shape.drips.map((drip, i) => (
            <path
              key={i}
              d={drip.d}
              fill={pal.fill}
              className="tomato-drip"
              style={fresh ? { animationDelay: `${drip.delay}s` } : undefined}
            />
          ))}
        </g>
        <g className="tomato-splat-body" transform={`rotate(${shape.rotation})`}>
          <path d={shape.blob} fill={pal.fill} className="tomato-splat-hit" />
          {shape.droplets.map((d, i) => (
            <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={pal.fill} />
          ))}
          <path d={shape.highlight} fill="#ffb3a1" opacity={pal.gloss} />
          {shape.seeds.map((s, i) => (
            <ellipse
              key={i}
              cx={s.cx}
              cy={s.cy}
              rx="2.2"
              ry="1.3"
              fill="#f4d47c"
              opacity={pal.seedOpacity}
              transform={`rotate(${s.rot} ${s.cx} ${s.cy})`}
            />
          ))}
        </g>
      </svg>
    </div>
  );
});

/**
 * Overlay of splats stuck to a message. Splats present when the message first
 * renders are drawn already-landed; any that arrive afterwards (a live throw)
 * fly in, splat, drip, and make a noise.
 */
export default function TomatoSplats({ splats }: { splats?: MessageSplat[] | null }) {
  // Snapshot of what was already stuck when this message first rendered.
  const [initialIds] = useState(() => new Set((splats ?? []).map((s) => s.id)));
  const soundedIds = useRef(new Set<string>());

  const freshIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of splats ?? []) {
      if (!s.wipedAt && !initialIds.has(s.id)) set.add(s.id);
    }
    return set;
  }, [splats, initialIds]);

  useEffect(() => {
    const toSound = [...freshIds].filter((id) => !soundedIds.current.has(id));
    if (toSound.length === 0) return;
    toSound.forEach((id) => soundedIds.current.add(id));
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t = window.setTimeout(playSplatSound, reduced ? 0 : IMPACT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [freshIds]);

  if (!splats?.length) return null;
  return (
    <div className="tomato-splat-layer">
      {splats.map((s) => (
        <Splat key={s.id} splat={s} fresh={freshIds.has(s.id)} />
      ))}
    </div>
  );
}

/** Click-to-aim overlay covering a message while the thrower picks a target. */
export function TomatoAimOverlay({
  ammo,
  onThrow,
  onCancel,
}: {
  ammo: TomatoAmmo | null;
  onThrow: (x: number, y: number) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    // Defer so the click that opened aim mode doesn't immediately cancel it.
    const t = window.setTimeout(() => window.addEventListener("pointerdown", onDown, true), 0);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.clearTimeout(t);
    };
  }, [onCancel]);

  return (
    <div
      ref={ref}
      className="tomato-aim-overlay"
      onClick={(e) => {
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        onThrow((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
    >
      <div className="tomato-aim-hint">
        🍅 Click to throw
        {ammo && <span className="tomato-aim-ammo">{ammo.remaining}/{ammo.max} left</span>}
        <span className="tomato-aim-esc">Esc to cancel</span>
      </div>
    </div>
  );
}
