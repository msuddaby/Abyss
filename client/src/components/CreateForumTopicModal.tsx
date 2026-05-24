import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useXenForoStore, useToastStore } from '@abyss/shared';
import type { XenForoNode } from '@abyss/shared';
import { useForumTopicStore } from '../stores/forumTopicStore';

function extractErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (typeof data === 'string' && data.length > 0) return data;
  if (data && typeof data === 'object') {
    const obj = data as { detail?: string; title?: string; message?: string };
    return obj.detail || obj.title || obj.message || fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export default function CreateForumTopicModal() {
  const range = useForumTopicStore((s) => s.modalRange);
  const closeModal = useForumTopicStore((s) => s.closeModal);

  const connection = useXenForoStore((s) => s.connection);
  const connectionLoaded = useXenForoStore((s) => s.connectionLoaded);
  const fetchConnection = useXenForoStore((s) => s.fetchConnection);
  const nodes = useXenForoStore((s) => s.nodes);
  const nodesLoaded = useXenForoStore((s) => s.nodesLoaded);
  const fetchNodes = useXenForoStore((s) => s.fetchNodes);
  const createTopic = useXenForoStore((s) => s.createTopic);
  const addToast = useToastStore((s) => s.addToast);

  const [title, setTitle] = useState('');
  const [nodeId, setNodeId] = useState<number | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodesError, setNodesError] = useState<string | null>(null);

  useEffect(() => {
    if (!range) return;
    setTitle('');
    setNodeId('');
    setError(null);
    setNodesError(null);
    if (!connectionLoaded) fetchConnection();
    if (connection) {
      fetchNodes().catch((e: unknown) => {
        setNodesError(extractErrorMessage(e, 'Failed to load forums.'));
      });
    }
  }, [range, connection, connectionLoaded, fetchConnection, fetchNodes]);

  const sortedNodes = useMemo<XenForoNode[]>(() => {
    return [...nodes].sort((a, b) => a.title.localeCompare(b.title));
  }, [nodes]);

  if (!range) return null;

  const handleClose = () => {
    if (submitting) return;
    closeModal();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmed = title.trim();
    if (!trimmed) {
      setError('Title is required');
      return;
    }
    if (!nodeId || typeof nodeId !== 'number') {
      setError('Select a forum');
      return;
    }

    setSubmitting(true);
    try {
      const result = await createTopic(range.channelId, {
        startMessageId: range.startMessage.id,
        endMessageId: range.endMessage.id,
        nodeId,
        title: trimmed,
      });
      addToast(`Forum topic created: ${result.url}`, 'success');
      closeModal();
    } catch (err: unknown) {
      setError(extractErrorMessage(err, 'Failed to create forum topic.'));
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create Forum Topic</h2>

        {!connectionLoaded && <div className="settings-help">Checking XenForo link…</div>}

        {connectionLoaded && !connection && (
          <>
            <p className="settings-help" style={{ marginTop: 0 }}>
              You need to link your XenForo account before you can create forum topics.
              Open Settings → Connections to link.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={handleClose}>Close</button>
            </div>
          </>
        )}

        {connectionLoaded && connection && (
          <form onSubmit={handleSubmit}>
            <p className="settings-help" style={{ marginTop: 0, marginBottom: 12 }}>
              Posting as <strong>{connection.xfUsername}</strong>.
              Messages from the selected range will be posted to the chosen forum.
            </p>

            {error && <div className="auth-error">{error}</div>}
            {nodesError && <div className="auth-error">{nodesError}</div>}

            <label>
              Title
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
                autoFocus
                disabled={submitting}
              />
            </label>

            <label>
              Forum
              <select
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value ? Number(e.target.value) : '')}
                disabled={submitting || !nodesLoaded}
              >
                <option value="">{nodesLoaded ? 'Select a forum…' : 'Loading forums…'}</option>
                {sortedNodes.map((n) => (
                  <option key={n.nodeId} value={n.nodeId}>{n.title}</option>
                ))}
              </select>
            </label>

            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={handleClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" disabled={submitting || !nodesLoaded}>
                {submitting ? 'Creating…' : 'Create Topic'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
