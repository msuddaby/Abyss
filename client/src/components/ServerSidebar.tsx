import { useEffect, useState, useRef } from 'react';
import { useServerStore, useDmStore, useUnreadStore, useAuthStore, getApiBase, hasPermission, Permission } from '@abyss/shared';
import CreateServerModal from './CreateServerModal';
import JoinServerModal from './JoinServerModal';
import ServerSettingsModal from './ServerSettingsModal';
import ServerNotificationModal from './ServerNotificationModal';
import InviteModal from './InviteModal';
import ConfirmModal from './ConfirmModal';

export default function ServerSidebar() {
  const { servers, activeServer, fetchServers, setActiveServer, leaveServer, members } = useServerStore();
  const { isDmMode, enterDmMode, exitDmMode, fetchDmChannels } = useDmStore();
  const serverUnreads = useUnreadStore((s) => s.serverUnreads);
  const dmUnreads = useUnreadStore((s) => s.dmUnreads);
  const currentUser = useAuthStore((s) => s.user);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [serverToEdit, setServerToEdit] = useState<typeof servers[number] | null>(null);
  const [serverToLeave, setServerToLeave] = useState<typeof servers[number] | null>(null);
  const [contextMenuServer, setContextMenuServer] = useState<typeof servers[number] | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [notifSettingsServer, setNotifSettingsServer] = useState<typeof servers[number] | null>(null);
  const [inviteServer, setInviteServer] = useState<typeof servers[number] | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const dmUnread = (() => {
    let hasUnread = false;
    let mentionCount = 0;
    for (const [, val] of dmUnreads) {
      if (val.hasUnread) hasUnread = true;
      mentionCount += val.mentionCount;
    }
    return { hasUnread, mentionCount };
  })();

  const handleDmClick = () => {
    enterDmMode();
    useServerStore.getState().clearActiveServer();
    fetchDmChannels();
  };

  const handleServerClick = (server: typeof servers[0]) => {
    exitDmMode();
    setActiveServer(server);
  };

  const currentMember = members.find((m) => m.userId === currentUser?.id);
  const canManageServer = currentMember ? hasPermission(currentMember, Permission.ManageServer) : false;
  const isOwner = currentMember?.isOwner ?? false;

  useEffect(() => {
    if (!contextMenuServer) return;
    const handleClick = () => setContextMenuServer(null);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenuServer(null);
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [contextMenuServer]);

  useEffect(() => {
    if (!contextMenuServer || !contextMenuRef.current) return;

    requestAnimationFrame(() => {
      if (!contextMenuRef.current) return;
      const rect = contextMenuRef.current.getBoundingClientRect();
      const margin = 8;
      let left = contextMenuPos.x;
      let top = contextMenuPos.y;
      if (left + rect.width > window.innerWidth - margin) {
        left = window.innerWidth - rect.width - margin;
      }
      if (top + rect.height > window.innerHeight - margin) {
        top = window.innerHeight - rect.height - margin;
      }
      if (left < margin) left = margin;
      if (top < margin) top = margin;
      if (left !== contextMenuPos.x || top !== contextMenuPos.y) {
        setContextMenuPos({ x: left, y: top });
      }
    });
  }, [contextMenuServer]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleServerContextMenu = (server: typeof servers[0]) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenuServer(server);
  };

  const handleEditServer = async (server: typeof servers[0]) => {
    exitDmMode();
    await setActiveServer(server);
    setServerToEdit(server);
  };

  return (
    <div className="server-sidebar">
      <div className="server-list">
        <div className="server-icon-wrapper">
          {dmUnread.hasUnread && !isDmMode && <div className="server-unread-dot" />}
          <button
            className={`server-icon dm-icon ${isDmMode ? 'active' : ''}`}
            onClick={handleDmClick}
            title="Direct Messages"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
            </svg>
          </button>
          {dmUnread.mentionCount > 0 && (
            <div className="server-mention-badge">{dmUnread.mentionCount > 99 ? '99+' : dmUnread.mentionCount}</div>
          )}
        </div>
        <div className="server-sidebar-separator" />
        {servers.map((server) => {
          const unread = serverUnreads.get(server.id);
          const hasUnread = unread?.hasUnread && activeServer?.id !== server.id;
          const mentionCount = unread?.mentionCount || 0;
          return (
            <div key={server.id} className="server-icon-wrapper" onContextMenu={handleServerContextMenu(server)}>
              {hasUnread && <div className="server-unread-dot" />}
              <button
                className={`server-icon ${activeServer?.id === server.id ? 'active' : ''}`}
                onClick={() => handleServerClick(server)}
                title={server.name}
              >
                {server.iconUrl ? (
                  <img src={server.iconUrl.startsWith('http') ? server.iconUrl : `${getApiBase()}${server.iconUrl}`} alt={server.name} />
                ) : (
                  <span>{server.name.charAt(0).toUpperCase()}</span>
                )}
              </button>
              {mentionCount > 0 && (
                <div className="server-mention-badge">{mentionCount > 99 ? '99+' : mentionCount}</div>
              )}
            </div>
          );
        })}
      </div>
      <div className="server-actions">
        <button className="server-icon add-server" onClick={() => setShowCreate(true)} title="Create Server">
          <span>+</span>
        </button>
        <button className="server-icon join-server" onClick={() => setShowJoin(true)} title="Join Server">
          <span>↗</span>
        </button>
      </div>
      {showCreate && <CreateServerModal onClose={() => setShowCreate(false)} />}
      {showJoin && <JoinServerModal onClose={() => setShowJoin(false)} />}
      {serverToEdit && (
        <ServerSettingsModal
          serverId={serverToEdit.id}
          onClose={() => setServerToEdit(null)}
        />
      )}
      {contextMenuServer && (
        <div ref={contextMenuRef} className="context-menu" style={{ left: contextMenuPos.x, top: contextMenuPos.y }}>
          <button
            className="context-menu-item"
            onClick={() => { setNotifSettingsServer(contextMenuServer); setContextMenuServer(null); }}
          >
            Notification Settings
          </button>
          <button
            className="context-menu-item"
            onClick={() => { setInviteServer(contextMenuServer); setContextMenuServer(null); }}
          >
            Invite People
          </button>
          {(((contextMenuServer.id === activeServer?.id) && (canManageServer || isOwner)) || contextMenuServer.ownerId === currentUser?.id) && (
            <button
              className="context-menu-item"
              onClick={() => { const server = contextMenuServer; setContextMenuServer(null); if (server) handleEditServer(server); }}
            >
              Server Settings
            </button>
          )}
          {contextMenuServer.ownerId !== currentUser?.id && (
            <>
              <div className="context-menu-separator" />
              <button
                className="context-menu-item danger"
                onClick={() => { setServerToLeave(contextMenuServer); setContextMenuServer(null); }}
              >
                Leave Server
              </button>
            </>
          )}
        </div>
      )}
      {serverToLeave && (
        <ConfirmModal
          title={`Leave ${serverToLeave.name}?`}
          message={`You will lose access to ${serverToLeave.name}.`}
          confirmLabel="Leave"
          danger
          onConfirm={async () => {
            await leaveServer(serverToLeave.id);
            setServerToLeave(null);
          }}
          onClose={() => setServerToLeave(null)}
        />
      )}
      {inviteServer && (
        <InviteModal serverId={inviteServer.id} onClose={() => setInviteServer(null)} />
      )}
      {notifSettingsServer && (
        <ServerNotificationModal
          serverId={notifSettingsServer.id}
          onClose={() => setNotifSettingsServer(null)}
        />
      )}
    </div>
  );
}
