import { useState, useRef, useEffect, useCallback } from 'react';
import { audioBufferToWavFile } from '../utils/audioUtils';

interface Props {
  file: File;
  maxDuration: number;
  onConfirm: (trimmedFile: File) => void;
  onCancel: () => void;
}

export default function AudioTrimmer({ file, maxDuration, onConfirm, onCancel }: Props) {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animRef = useRef<number>(0);
  const playStartRef = useRef(0);
  const draggingRef = useRef<'start' | 'end' | 'region' | null>(null);
  const dragOffsetRef = useRef(0);

  // Decode audio file
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        audioCtxRef.current = ctx;
        if (cancelled) return;
        setAudioBuffer(decoded);
        const dur = Math.min(decoded.duration, maxDuration);
        setStartTime(0);
        setEndTime(dur);
      } catch {
        if (!cancelled) setError('Could not read audio file');
      }
    })();
    return () => { cancelled = true; };
  }, [file, maxDuration]);

  // Draw waveform
  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const dur = audioBuffer.duration;
    const data = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / w));

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = 'var(--bg-secondary)';
    ctx.fillRect(0, 0, w, h);

    // Selected region highlight
    const startX = (startTime / dur) * w;
    const endX = (endTime / dur) * w;
    ctx.fillStyle = 'rgba(88, 101, 242, 0.15)';
    ctx.fillRect(startX, 0, endX - startX, h);

    // Waveform bars
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const sampleIdx = Math.floor((x / w) * data.length);
      let max = 0;
      for (let j = 0; j < step; j++) {
        const abs = Math.abs(data[sampleIdx + j] || 0);
        if (abs > max) max = abs;
      }
      const barH = max * mid * 0.9;
      const t = x / w * dur;
      const inSelection = t >= startTime && t <= endTime;
      ctx.fillStyle = inSelection ? 'var(--accent)' : 'var(--text-muted)';
      ctx.fillRect(x, mid - barH, 1, barH * 2);
    }

    // Handle lines
    ctx.strokeStyle = 'var(--accent)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(startX, 0); ctx.lineTo(startX, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(endX, 0); ctx.lineTo(endX, h); ctx.stroke();

    // Handle grab areas
    ctx.fillStyle = 'var(--accent)';
    ctx.fillRect(startX - 3, 0, 6, h);
    ctx.fillRect(endX - 3, 0, 6, h);

    // Playhead
    if (isPlaying) {
      const phX = (playhead / dur) * w;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, h); ctx.stroke();
    }
  }, [audioBuffer, startTime, endTime, isPlaying, playhead]);

  useEffect(() => {
    drawWaveform();
  }, [drawWaveform]);

  // Mouse interaction
  const getTimeFromX = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !audioBuffer) return 0;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    return (x / rect.width) * audioBuffer.duration;
  }, [audioBuffer]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!audioBuffer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;
    const dur = audioBuffer.duration;
    const startX = (startTime / dur) * w;
    const endX = (endTime / dur) * w;

    if (Math.abs(x - startX) < 8) {
      draggingRef.current = 'start';
    } else if (Math.abs(x - endX) < 8) {
      draggingRef.current = 'end';
    } else if (x > startX && x < endX) {
      draggingRef.current = 'region';
      dragOffsetRef.current = (x / w) * dur - startTime;
    }
  }, [audioBuffer, startTime, endTime]);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!draggingRef.current || !audioBuffer) return;
      const t = getTimeFromX(e.clientX);
      const dur = audioBuffer.duration;
      const selDur = endTime - startTime;

      if (draggingRef.current === 'start') {
        const newStart = Math.max(0, Math.min(t, endTime - 0.1));
        const newDur = endTime - newStart;
        if (newDur <= maxDuration) {
          setStartTime(newStart);
        }
      } else if (draggingRef.current === 'end') {
        const newEnd = Math.min(dur, Math.max(t, startTime + 0.1));
        const newDur = newEnd - startTime;
        if (newDur <= maxDuration) {
          setEndTime(newEnd);
        }
      } else if (draggingRef.current === 'region') {
        const newStart = Math.max(0, Math.min(t - dragOffsetRef.current, dur - selDur));
        setStartTime(newStart);
        setEndTime(newStart + selDur);
      }
    };
    const handleUp = () => { draggingRef.current = null; };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [audioBuffer, startTime, endTime, maxDuration, getTimeFromX]);

  // Preview playback
  const stopPreview = useCallback(() => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch {}
      sourceRef.current = null;
    }
    cancelAnimationFrame(animRef.current);
    setIsPlaying(false);
  }, []);

  const startPreview = useCallback(() => {
    if (!audioBuffer || !audioCtxRef.current) return;
    stopPreview();
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    const duration = endTime - startTime;
    source.start(0, startTime, duration);
    sourceRef.current = source;
    playStartRef.current = ctx.currentTime;
    setIsPlaying(true);

    const animate = () => {
      const elapsed = ctx.currentTime - playStartRef.current;
      setPlayhead(startTime + elapsed);
      if (elapsed < duration) {
        animRef.current = requestAnimationFrame(animate);
      } else {
        setIsPlaying(false);
      }
    };
    animRef.current = requestAnimationFrame(animate);
    source.onended = () => {
      setIsPlaying(false);
      cancelAnimationFrame(animRef.current);
    };
  }, [audioBuffer, startTime, endTime, stopPreview]);

  // Cleanup
  useEffect(() => {
    return () => {
      stopPreview();
      audioCtxRef.current?.close();
    };
  }, [stopPreview]);

  const handleConfirm = () => {
    if (!audioBuffer) return;
    const trimmed = audioBufferToWavFile(audioBuffer, file.name, startTime, endTime);
    onConfirm(trimmed);
  };

  const selectionDuration = endTime - startTime;

  if (error) {
    return (
      <div className="audio-trimmer">
        <p className="audio-trimmer-error">{error}</p>
        <button onClick={onCancel}>Cancel</button>
      </div>
    );
  }

  if (!audioBuffer) {
    return <div className="audio-trimmer"><p>Loading audio...</p></div>;
  }

  const formatTime = (t: number) => {
    const s = Math.floor(t);
    const ms = Math.floor((t - s) * 10);
    return `${s}.${ms}s`;
  };

  return (
    <div className="audio-trimmer" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="audio-trimmer-canvas"
        onMouseDown={handleMouseDown}
      />
      <div className="audio-trimmer-time">
        <span>{formatTime(startTime)}</span>
        <span>{formatTime(selectionDuration)} / {maxDuration}s max</span>
        <span>{formatTime(endTime)}</span>
      </div>
      <div className="audio-trimmer-actions">
        <button onClick={isPlaying ? stopPreview : startPreview}>
          {isPlaying ? 'Stop' : 'Preview'}
        </button>
        <button onClick={handleConfirm}>Confirm</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
