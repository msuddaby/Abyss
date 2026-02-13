import { useRef, useLayoutEffect, useEffect } from 'react';
import { useAuthStore, useServerStore, useDmStore, useVoiceStore, useVoiceChatStore } from '@abyss/shared';
import { isMobile } from '../../stores/mobileStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { GROUP_ORDER } from './types';
import type { MenuItem, ProviderContext, MenuGroup } from './types';
import { userProvider } from './providers/userProvider';
import { memberProvider } from './providers/memberProvider';
import { messageProvider } from './providers/messageProvider';
import { voiceProvider } from './providers/voiceProvider';
import { channelProvider } from './providers/channelProvider';
import { serverProvider } from './providers/serverProvider';

const providers = [userProvider, memberProvider, messageProvider, voiceProvider, channelProvider, serverProvider];

export default function ContextMenu() {
  const isOpen = useContextMenuStore((s) => s.isOpen);
  const position = useContextMenuStore((s) => s.position);
  const entities = useContextMenuStore((s) => s.entities);
  const actions = useContextMenuStore((s) => s.actions);
  const close = useContextMenuStore((s) => s.close);

  const currentUser = useAuthStore((s) => s.user);
  const members = useServerStore((s) => s.members);
  const activeServer = useServerStore((s) => s.activeServer);
  const activeChannel = useServerStore((s) => s.activeChannel);
  const isDmMode = useDmStore((s) => s.isDmMode);
  const voiceChannelId = useVoiceStore((s) => s.currentChannelId);
  const voiceParticipants = useVoiceStore((s) => s.participants);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);
  const ttsUsers = useVoiceChatStore((s) => s.ttsUsers);

  const menuRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef(0);

  // Track when the menu opens to ignore lingering touches from long-press
  useEffect(() => {
    if (isOpen) openedAtRef.current = Date.now();
  }, [isOpen]);

  // Viewport clamping — mutate DOM directly to avoid setState-in-effect
  // Skip on mobile: CSS positions it as a bottom sheet
  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current || isMobile()) return;
    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = position.x;
    let top = position.y;
    if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - rect.width - margin;
    if (top + rect.height > window.innerHeight - margin) top = window.innerHeight - rect.height - margin;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  // Click outside dismissal
  useEffect(() => {
    if (!isOpen) return;
    const handle = () => {
      // Ignore synthetic mousedown from long-press touchend
      if (Date.now() - openedAtRef.current < 500) return;
      close();
    };
    // setTimeout(0) so the triggering right-click doesn't immediately close
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handle);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handle);
    };
  }, [isOpen, close]);

  // Escape key dismissal
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [isOpen, close]);

  if (!isOpen) return null;

  const currentMember = members.find((m) => m.userId === currentUser?.id);

  const ctx: ProviderContext = {
    entities,
    actions,
    currentUser: currentUser ?? null,
    currentMember,
    activeServer: activeServer ?? null,
    activeChannel: activeChannel ?? null,
    isDmMode,
    voiceChannelId,
    voiceParticipants,
    userVolumes,
    ttsUsers,
  };

  const allItems: MenuItem[] = [];
  for (const provider of providers) {
    allItems.push(...provider(ctx));
  }

  if (allItems.length === 0) return null;

  // Group and sort
  const grouped = new Map<MenuGroup, MenuItem[]>();
  for (const item of allItems) {
    const list = grouped.get(item.group);
    if (list) list.push(item);
    else grouped.set(item.group, [item]);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.order - b.order);
  }

  // Build render list with separators
  const renderGroups: { group: MenuGroup; items: MenuItem[] }[] = [];
  for (const g of GROUP_ORDER) {
    const items = grouped.get(g);
    if (items && items.length > 0) {
      renderGroups.push({ group: g, items });
    }
  }

  // Volume slider state for the target user
  const volumeUserId = entities.user?.id;
  const volumeValue = volumeUserId ? (userVolumes.get(volumeUserId) ?? 100) : 100;

  return (
    <>
      <div className="context-menu-overlay" onMouseDown={() => {
        if (Date.now() - openedAtRef.current < 400) return;
        close();
      }} onTouchEnd={(e) => {
        if (Date.now() - openedAtRef.current < 400) e.preventDefault();
      }} />
      <div
        ref={menuRef}
        className="context-menu"
        style={isMobile() ? undefined : { left: position.x, top: position.y }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {renderGroups.map((rg, gi) => (
          <div key={rg.group}>
            {gi > 0 && <div className="context-menu-separator" />}
            {rg.items.map((item) => {
              if (item.id === 'voice-volume' && volumeUserId) {
                return (
                  <div
                    key={item.id}
                    className="context-menu-volume"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <div className="context-menu-volume-header">
                      <span>User Volume</span>
                      <span>{volumeValue}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      value={volumeValue}
                      onChange={(e) => setUserVolume(volumeUserId, Number(e.target.value))}
                    />
                  </div>
                );
              }
              return (
                <button
                  key={item.id}
                  className={`context-menu-item${item.danger ? ' danger' : ''}`}
                  onClick={() => {
                    if (Date.now() - openedAtRef.current < 400) return;
                    item.action();
                    if (!item.keepOpen) close();
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
