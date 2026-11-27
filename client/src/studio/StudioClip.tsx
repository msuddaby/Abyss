import { memo, useEffect, useMemo, useRef } from 'react';
import type { StudioClip as Clip } from '@abyss/shared';
import { beatsToSeconds } from '@abyss/shared';
import { getPeaks } from './engine/assetCache';
import { TRACK_HEIGHT } from './studioUtils';

export type ClipDragMode = 'move' | 'trim-start' | 'trim-end';

interface Props {
  id: string;
  clip: Clip;
  pxPerBeat: number;
  bpm: number;
  color: string;
  selected: boolean;
  /** Colors of collaborators who have this clip selected */
  remoteColors: string[];
  ghost?: boolean;
  ghostColor?: string;
  /** Bumps when any asset finishes loading so waveforms redraw */
  peaksVersion: number;
  editable: boolean;
  onPointerDown?: (e: React.PointerEvent, id: string, mode: ClipDragMode) => void;
  onDoubleClick?: (id: string) => void;
}

const EDGE_PX = 6;
const MAX_CANVAS_PX = 8192;

function Waveform({ clip, width, height, bpm, peaksVersion }: { clip: Clip; width: number; height: number; bpm: number; peaksVersion: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !clip.assetId) return;
    const peaks = getPeaks(clip.assetId);
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.min(width, MAX_CANVAS_PX));
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, height);
    if (!peaks) return;

    const bucketsPerSec = peaks.sampleRate / peaks.samplesPerBucket;
    const startBucket = (clip.offset ?? 0) * bucketsPerSec;
    const totalBuckets = peaks.data.length / 2;
    const clipBuckets = beatsToSeconds(clip.length, bpm) * bucketsPerSec;
    const bucketsPerPx = clipBuckets / cssW;
    const mid = height / 2;
    const gain = Math.pow(10, (clip.gain ?? 0) / 20);

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (let x = 0; x < cssW; x++) {
      const b0 = Math.floor(startBucket + x * bucketsPerPx);
      const b1 = Math.max(b0 + 1, Math.floor(startBucket + (x + 1) * bucketsPerPx));
      if (b0 >= totalBuckets) break;
      let min = 1, max = -1;
      for (let b = b0; b < Math.min(b1, totalBuckets); b++) {
        const lo = peaks.data[b * 2], hi = peaks.data[b * 2 + 1];
        if (lo < min) min = lo;
        if (hi > max) max = hi;
      }
      const y0 = mid - Math.min(1, max * gain) * mid;
      const y1 = mid - Math.max(-1, min * gain) * mid;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [clip.assetId, clip.offset, clip.length, clip.gain, width, height, bpm, peaksVersion]);

  return <canvas ref={canvasRef} className="studio-clip-wave" />;
}

function MidiPreview({ clip, width, height }: { clip: Clip; width: number; height: number }) {
  const notes = useMemo(() => Object.values(clip.notes ?? {}), [clip.notes]);
  if (notes.length === 0) return null;
  let lo = 127, hi = 0;
  for (const n of notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
  const range = Math.max(12, hi - lo + 1);
  const base = lo - Math.floor((range - (hi - lo + 1)) / 2);
  const rowH = height / range;
  return (
    <svg className="studio-clip-midi" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {notes.map((n, i) => n.start < clip.length && (
        <rect
          key={i}
          x={(n.start / clip.length) * width}
          y={height - (n.pitch - base + 1) * rowH}
          width={Math.max(1.5, (Math.min(n.len, clip.length - n.start) / clip.length) * width)}
          height={Math.max(1.5, rowH - 0.5)}
          rx={1}
        />
      ))}
    </svg>
  );
}

function StudioClipView({ id, clip, pxPerBeat, bpm, color, selected, remoteColors, ghost, ghostColor, peaksVersion, editable, onPointerDown, onDoubleClick }: Props) {
  const width = Math.max(4, clip.length * pxPerBeat);
  const height = TRACK_HEIGHT - 8;
  const bodyH = height - 16;

  const handleDown = (e: React.PointerEvent) => {
    if (!onPointerDown || e.button !== 0) return;
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    let mode: ClipDragMode = 'move';
    if (editable && width > EDGE_PX * 3) {
      if (x <= EDGE_PX) mode = 'trim-start';
      else if (x >= rect.width - EDGE_PX) mode = 'trim-end';
    }
    onPointerDown(e, id, mode);
  };

  const outline = remoteColors[0];
  return (
    <div
      className={`studio-clip ${clip.kind}${selected ? ' selected' : ''}${ghost ? ' ghost' : ''}`}
      style={{
        left: clip.start * pxPerBeat,
        width,
        ['--clip-color' as string]: color,
        ...(ghost && ghostColor ? { borderColor: ghostColor } : {}),
        ...(!ghost && outline ? { boxShadow: `0 0 0 2px ${outline}` } : {}),
      }}
      onPointerDown={ghost ? undefined : handleDown}
      onDoubleClick={ghost ? undefined : (e) => { e.stopPropagation(); onDoubleClick?.(id); }}
    >
      <div className="studio-clip-label">{clip.name || (clip.kind === 'midi' ? 'MIDI' : 'Audio')}</div>
      <div className="studio-clip-body">
        {clip.kind === 'audio'
          ? <Waveform clip={clip} width={width} height={bodyH} bpm={bpm} peaksVersion={peaksVersion} />
          : <MidiPreview clip={clip} width={width} height={bodyH} />}
      </div>
      {editable && !ghost && (
        <>
          <div className="studio-clip-edge left" />
          <div className="studio-clip-edge right" />
        </>
      )}
    </div>
  );
}

export default memo(StudioClipView);
