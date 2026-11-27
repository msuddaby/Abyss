import { useRef, useState } from 'react';

// Range input that previews continuously (onInput) but only commits once the
// user lets go. Keeps slider drags from flooding the collaborative op stream.

interface Props {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  className?: string;
  title?: string;
  onPreview?: (v: number) => void;
  onCommit: (v: number) => void;
  /** Value to reset to on double-click */
  resetValue?: number;
}

export default function CommitSlider({ value, min, max, step, disabled, className, title, onPreview, onCommit, resetValue }: Props) {
  const [local, setLocal] = useState(value);
  const [synced, setSynced] = useState(value);
  const [active, setActive] = useState(false);
  const dragging = useRef(false);

  // Adopt external (e.g. collaborator) changes unless the user is mid-drag.
  if (value !== synced && !active) {
    setSynced(value);
    setLocal(value);
  }

  const commit = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    if (local !== value) onCommit(local);
  };

  return (
    <input
      type="range"
      className={className}
      title={title}
      min={min}
      max={max}
      step={step}
      value={local}
      disabled={disabled}
      onPointerDown={() => { dragging.current = true; setActive(true); }}
      onChange={(e) => {
        const v = Number(e.target.value);
        dragging.current = true;
        setActive(true);
        setLocal(v);
        onPreview?.(v);
      }}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
      onDoubleClick={() => {
        if (resetValue === undefined || disabled) return;
        setLocal(resetValue);
        onPreview?.(resetValue);
        onCommit(resetValue);
      }}
    />
  );
}
