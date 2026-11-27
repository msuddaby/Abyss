import type { ReactNode } from 'react';

interface Props {
  title: string;
  width: number;
  color: string;
  on?: boolean;
  editable: boolean;
  onToggle?: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  onRemove?: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
}

/** Title bar + body, like a device in Ableton's chain view. */
export default function DeviceFrame({ title, width, color, on = true, editable, onToggle, onMoveLeft, onMoveRight, onRemove, headerExtra, children }: Props) {
  return (
    <div className={`studio-device${on ? '' : ' off'}`} style={{ width, ['--device-color' as string]: color }}>
      <div className="studio-device-head">
        {onToggle && (
          <button
            className={`studio-device-power${on ? ' on' : ''}`}
            disabled={!editable}
            onClick={onToggle}
            title={on ? 'Turn off (bypass)' : 'Turn on'}
          />
        )}
        <span className="studio-device-title">{title}</span>
        {headerExtra}
        <div className="studio-spacer" />
        {editable && onMoveLeft && <button className="studio-icon-btn" onClick={onMoveLeft} title="Move left">◂</button>}
        {editable && onMoveRight && <button className="studio-icon-btn" onClick={onMoveRight} title="Move right">▸</button>}
        {editable && onRemove && <button className="studio-icon-btn danger" onClick={onRemove} title="Delete device">✕</button>}
      </div>
      {children}
    </div>
  );
}
