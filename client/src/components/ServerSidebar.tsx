import { useEffect, useState } from 'react';
import { useServerStore } from '../stores/serverStore';
import CreateServerModal from './CreateServerModal';
import JoinServerModal from './JoinServerModal';

export default function ServerSidebar() {
  const { servers, activeServer, fetchServers, setActiveServer } = useServerStore();
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  return (
    <div className="server-sidebar">
      <div className="server-list">
        {servers.map((server) => (
          <button
            key={server.id}
            className={`server-icon ${activeServer?.id === server.id ? 'active' : ''}`}
            onClick={() => setActiveServer(server)}
            title={server.name}
          >
            {server.iconUrl ? (
              <img src={server.iconUrl} alt={server.name} />
            ) : (
              <span>{server.name.charAt(0).toUpperCase()}</span>
            )}
          </button>
        ))}
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
    </div>
  );
}
