import { useEffect, useState } from 'react';
import { useServerStore, useDmStore, useFriendStore, useUnreadStore, useAuthStore, getApiBase, hasPermission, Permission } from '@abyss/shared';
import CreateServerModal from './CreateServerModal';
import JoinServerModal from './JoinServerModal';
import ServerSettingsModal from './ServerSettingsModal';
import ServerNotificationModal from './ServerNotificationModal';
import InviteModal from './InviteModal';
import ConfirmModal from './ConfirmModal';
import { useContextMenuStore } from '../stores/contextMenuStore';

export default function ServerSidebar() {
  const { activeServer, fetchServers, setActiveServer, leaveServer, members, getServersSortedByRecency } = useServerStore();
  const { isDmMode, enterDmMode, exitDmMode, fetchDmChannels } = useDmStore();
  const servers = getServersSortedByRecency();
  const serverUnreads = useUnreadStore((s) => s.serverUnreads);
  const dmUnreads = useUnreadStore((s) => s.dmUnreads);
  const pendingFriendRequests = useFriendStore((s) => s.requests.filter((r) => !r.isOutgoing).length);
  const currentUser = useAuthStore((s) => s.user);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [serverToEdit, setServerToEdit] = useState<typeof servers[number] | null>(null);
  const [serverToLeave, setServerToLeave] = useState<typeof servers[number] | null>(null);
  const [notifSettingsServer, setNotifSettingsServer] = useState<typeof servers[number] | null>(null);
  const [inviteServer, setInviteServer] = useState<typeof servers[number] | null>(null);
  const openContextMenu = useContextMenuStore((s) => s.open);

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
    // Pending friend requests also show on the DM icon
    if (pendingFriendRequests > 0) hasUnread = true;
    mentionCount += pendingFriendRequests;
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

  const handleServerContextMenu = (server: typeof servers[0]) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const canEdit = ((server.id === activeServer?.id) && (canManageServer || isOwner)) || server.ownerId === currentUser?.id;
    openContextMenu(e.clientX, e.clientY,
      { server },
      {
        onServerNotifSettings: () => setNotifSettingsServer(server),
        onInvite: () => setInviteServer(server),
        ...(canEdit ? { onServerSettings: () => handleEditServer(server) } : {}),
        ...(server.ownerId !== currentUser?.id ? { onLeaveServer: () => setServerToLeave(server) } : {}),
      }
    );
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
