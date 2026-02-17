import { useEffect, useRef } from 'react';
import { useVoiceStore } from '@abyss/shared';
import type { CameraQuality, ScreenShareQuality } from '@abyss/shared';
import { isMobile } from '../stores/mobileStore';

const CAMERA_OPTIONS: { value: CameraQuality; label: string; detail: string }[] = [
  { value: 'low', label: 'Low', detail: '360p 15fps' },
  { value: 'medium', label: 'Medium', detail: '480p 30fps' },
  { value: 'high', label: 'High', detail: '720p 30fps' },
  { value: 'very-high', label: 'Ultra', detail: '1080p 30fps' },
];

const SCREEN_OPTIONS: { value: ScreenShareQuality; label: string; detail: string }[] = [
  { value: 'quality', label: 'Quality', detail: '5fps' },
  { value: 'balanced', label: 'Balanced', detail: '15fps' },
  { value: 'motion', label: 'Motion', detail: '30fps' },
  { value: 'high-motion', label: 'High Motion', detail: '60fps' },
];

interface QualityPopoverProps {
  type: 'camera' | 'screen';
  anchorRect: DOMRect | null;
  onClose: () => void;
}

export default function QualityPopover({ type, anchorRect, onClose }: QualityPopoverProps) {
  const cameraQuality = useVoiceStore((s) => s.cameraQuality);
  const screenShareQuality = useVoiceStore((s) => s.screenShareQuality);
  const setCameraQuality = useVoiceStore((s) => s.setCameraQuality);
  const setScreenShareQuality = useVoiceStore((s) => s.setScreenShareQuality);
  const panelRef = useRef<HTMLDivElement>(null);
  const mobile = isMobile();

  const options = type === 'camera' ? CAMERA_OPTIONS : SCREEN_OPTIONS;
  const current = type === 'camera' ? cameraQuality : screenShareQuality;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    // Delay click listener to avoid closing immediately from the context menu event
    const timer = setTimeout(() => window.addEventListener('mousedown', handleClick), 0);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('mousedown', handleClick);
      clearTimeout(timer);
    };
  }, [onClose]);

  const handleSelect = (value: string) => {
    if (type === 'camera') {
      setCameraQuality(value as CameraQuality);
    } else {
      setScreenShareQuality(value as ScreenShareQuality);
    }
    onClose();
  };

  const title = type === 'camera' ? 'Camera Quality' : 'Screen Share Quality';

  if (mobile) {
    return (
      <div className="quality-popover-overlay" onMouseDown={onClose} onTouchStart={onClose}>
        <div
          ref={panelRef}
          className="quality-popover mobile"
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <div className="quality-popover-title">{title}</div>
          <div className="quality-popover-options">
            {options.map((opt) => (
              <button
                key={opt.value}
                className={`quality-popover-option${current === opt.value ? ' active' : ''}`}
                onClick={() => handleSelect(opt.value)}
              >
                <span className="quality-popover-option-label">{opt.label}</span>
                <span className="quality-popover-option-detail">{opt.detail}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Desktop: position above anchor
  const style: React.CSSProperties = {};
  if (anchorRect) {
    style.position = 'fixed';
    style.bottom = window.innerHeight - anchorRect.top + 6;
    style.left = anchorRect.left + anchorRect.width / 2;
    style.transform = 'translateX(-50%)';
  }

  return (
    <div ref={panelRef} className="quality-popover" style={style}>
      <div className="quality-popover-title">{title}</div>
      <div className="quality-popover-options">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`quality-popover-option${current === opt.value ? ' active' : ''}`}
            onClick={() => handleSelect(opt.value)}
          >
            <span className="quality-popover-option-label">{opt.label}</span>
            <span className="quality-popover-option-detail">{opt.detail}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
