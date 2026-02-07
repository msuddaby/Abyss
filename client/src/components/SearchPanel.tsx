import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchStore, useServerStore, useMessageStore, api, getApiBase } from '@abyss/shared';
import type { SearchResult, Message } from '@abyss/shared';

export default function SearchPanel() {
  const { query, setQuery, filters, setFilters, clearFilters, results, totalCount, loading, hasMore, search, loadMore, closeSearch } = useSearchStore();
  const activeServer = useServerStore((s) => s.activeServer);
  const channels = useServerStore((s) => s.channels);
  const members = useServerStore((s) => s.members);
  const setActiveChannel = useServerStore((s) => s.setActiveChannel);
  const fetchMessages = useMessageStore((s) => s.fetchMessages);
  const [showFilters, setShowFilters] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const textChannels = channels.filter((c) => c.type === 'Text');

  const doSearch = useCallback(() => {
    if (activeServer) search(activeServer.id);
  }, [activeServer, search]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch();
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, filters, doSearch]);

  const handleScroll = () => {
    const el = resultsRef.current;
    if (!el || !activeServer) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 100 && hasMore && !loading) {
      loadMore(activeServer.id);
    }
  };

  const jumpToMessage = async (result: SearchResult) => {
    if (!activeServer) return;
    const channel = textChannels.find((c) => c.name === result.channelName);
    if (!channel) return;

    // Switch to the channel if needed
    const currentChannel = useServerStore.getState().activeChannel;
    if (currentChannel?.id !== channel.id) {
      setActiveChannel(channel);
    }

    // Fetch messages around the target
    try {
      const res = await api.get(`/channels/${channel.id}/messages/around/${result.message.id}`);
      const messages: Message[] = res.data;
      useMessageStore.setState({
        messages,
        currentChannelId: channel.id,
        hasMore: true,
        loading: false,
      });

      // Scroll to and highlight the target message after render
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-message-id="${result.message.id}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('message-highlight');
          setTimeout(() => el.classList.remove('message-highlight'), 2000);
        }
      });
    } catch (e) {
      console.error('Failed to jump to message', e);
      // Fallback: just switch channel normally
      fetchMessages(channel.id);
    }
  };

  const highlightMatch = (text: string, q: string) => {
    if (!q.trim()) return text;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? <mark key={i} className="search-highlight">{part}</mark> : part
    );
  };

  const formatTime = (date: string) => {
    const d = new Date(date);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };

  return (
    <div className="search-panel">
      <div className="search-panel-header">
        <span>Search</span>
        <button className="search-close-btn" onClick={closeSearch}>&times;</button>
      </div>
      <div className="search-input-wrapper">
        <input
          className="search-input"
          type="text"
          placeholder="Search messages..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      <button className="search-filter-toggle" onClick={() => setShowFilters(!showFilters)}>
        {showFilters ? 'Hide Filters' : 'Filters'}
        {Object.values(filters).some(Boolean) && <span className="search-filter-active-dot" />}
      </button>
      {showFilters && (
        <div className="search-filters">
          <label>
            Channel
            <select
              value={filters.channelId || ''}
              onChange={(e) => setFilters({ ...filters, channelId: e.target.value || undefined })}
            >
              <option value="">All channels</option>
              {textChannels.map((c) => (
                <option key={c.id} value={c.id}>#{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            Author
            <select
              value={filters.authorId || ''}
              onChange={(e) => setFilters({ ...filters, authorId: e.target.value || undefined })}
            >
              <option value="">Anyone</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>{m.user.displayName}</option>
              ))}
            </select>
          </label>
          <label className="search-filter-checkbox">
            <input
              type="checkbox"
              checked={filters.hasAttachment || false}
              onChange={(e) => setFilters({ ...filters, hasAttachment: e.target.checked || undefined })}
            />
            Has attachment
          </label>
          <label>
            Before
            <input type="date" value={filters.before || ''} onChange={(e) => setFilters({ ...filters, before: e.target.value || undefined })} />
          </label>
          <label>
            After
            <input type="date" value={filters.after || ''} onChange={(e) => setFilters({ ...filters, after: e.target.value || undefined })} />
          </label>
          {Object.values(filters).some(Boolean) && (
            <button className="search-clear-filters" onClick={clearFilters}>Clear filters</button>
          )}
        </div>
      )}
      <div className="search-results-header">
        {totalCount > 0 && <span>{totalCount} result{totalCount !== 1 ? 's' : ''}</span>}
      </div>
      <div className="search-results" ref={resultsRef} onScroll={handleScroll}>
        {results.map((r: SearchResult) => (
          <button key={r.message.id} className="search-result-card" onClick={() => jumpToMessage(r)}>
            <div className="search-result-channel">#{r.channelName}</div>
            <div className="search-result-meta">
              <div className="search-result-avatar">
                {r.message.author.avatarUrl ? (
                  <img src={`${getApiBase()}${r.message.author.avatarUrl}`} alt="" />
                ) : (
                  r.message.author.displayName[0]
                )}
              </div>
              <span className="search-result-author">{r.message.author.displayName}</span>
              <span className="search-result-time">{formatTime(r.message.createdAt)}</span>
            </div>
            <div className="search-result-content">
              {highlightMatch(r.message.content, query)}
            </div>
            {r.message.attachments.length > 0 && (
              <span className="search-result-attachment-badge">
                {r.message.attachments.length} attachment{r.message.attachments.length > 1 ? 's' : ''}
              </span>
            )}
          </button>
        ))}
        {loading && <div className="loading">Searching...</div>}
        {!loading && query.trim() && results.length === 0 && (
          <div className="search-no-results">No results found</div>
        )}
      </div>
    </div>
  );
}
