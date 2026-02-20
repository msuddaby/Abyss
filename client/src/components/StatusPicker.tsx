import { useState, useRef, useEffect } from 'react';
import { useAuthStore, api, PresenceStatus } from '@abyss/shared';
import '../styles/StatusPicker.css';

interface StatusOption {
  value: number;
  label: string;
  className: string;
}

const statusOptions: StatusOption[] = [
  { value: PresenceStatus.Online, label: 'Online', className: 'online' },
  { value: PresenceStatus.Away, label: 'Away', className: 'away' },
  { value: PresenceStatus.DoNotDisturb, label: 'Do Not Disturb', className: 'dnd' },
  { value: PresenceStatus.Invisible, label: 'Invisible', className: 'offline' },
];

export default function StatusPicker() {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const setPresenceStatus = useAuthStore((s) => s.setPresenceStatus);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentStatus = statusOptions.find(s => s.value === user?.presenceStatus) || statusOptions[0];

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleStatusChange = async (status: number) => {
    try {
      await api.put('/auth/presence', {
        presenceStatus: status
      }, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      setPresenceStatus(status);
      setIsOpen(false);
    } catch (error) {
      console.error('Failed to update presence status:', error);
    }
  };

  return (
    <div className="status-picker" ref={dropdownRef}>
      <button
        className="status-picker-trigger"
        onClick={() => setIsOpen(!isOpen)}
        title={`Status: ${currentStatus.label}`}
      >
        <span className={`presence-dot ${currentStatus.className}`} />
      </button>

      {isOpen && (
        <div className="status-picker-dropdown">
          <div className="status-picker-header">Set your status</div>
          {statusOptions.map((option) => (
            <button
              key={option.value}
              className={`status-picker-option ${option.value === user?.presenceStatus ? 'active' : ''}`}
              onClick={() => handleStatusChange(option.value)}
            >
              <span className={`presence-dot ${option.className}`} />
              <span className="status-label">{option.label}</span>
              {option.value === user?.presenceStatus && (
                <svg className="status-check" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
