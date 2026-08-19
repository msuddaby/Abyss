import { useEffect, useState } from 'react';
import {
  useAuthStore,
  useServerStore,
  useMessageStore,
  usePresenceStore,
  useAppConfigStore,
  startConnection,
  getConnection,
  onReconnected,
  setOnUnauthorized,
  getStorage,
  api,
} from '@abyss/shared';
import MessageList from '../components/MessageList';
import MessageInput from '../components/MessageInput';
import TypingIndicator from '../components/TypingIndicator';
import ToastHost from '../components/ToastHost';
import ShoutboxHeader from './ShoutboxHeader';
import LoginPlaceholder from './LoginPlaceholder';

type Phase = 'loading' | 'ready' | 'unauthenticated' | 'error';

// The XenForo addon redirects the iframe to /widget.html#token=<jwt>. Read it
// from the fragment (never sent to a server, never in access logs) and scrub it
// from the address bar immediately.
function readTokenFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const token = new URLSearchParams(hash).get('token');
  try {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    /* ignore */
  }
  return token;
}

export default function WidgetApp() {
  const [phase, setPhase] = useState<Phase>('loading');
  const activeChannel = useServerStore((s) => s.activeChannel);

  useEffect(() => {
    let cancelled = false;
    const xfToken = readTokenFromHash();
    if (!xfToken) {
      setPhase('unauthenticated');
      return;
    }

    // A hard auth failure (refresh token rejected) should drop back to the
    // placeholder rather than silently breaking.
    setOnUnauthorized(() => setPhase('unauthenticated'));

    (async () => {
      try {
        // 1. Exchange the XenForo token for an Abyss session.
        const { data } = await api.post('/xenforo/shoutbox/session', { token: xfToken });
        const { token, refreshToken, serverId, channelId, user } = data;
        if (cancelled) return;

        // 2. Seed auth state + (in-memory) storage.
        const s = getStorage();
        s.setItem('token', token);
        s.setItem('refreshToken', refreshToken);
        s.setItem('user', JSON.stringify(user));
        useAuthStore.setState({
          token,
          refreshToken,
          user,
          isAuthenticated: true,
          isSysadmin: false,
          isGuest: true,
          initialized: true,
        });

        // 3. Connect SignalR (worker or direct; accessTokenFactory reads storage).
        await startConnection();

        // 4. Load the shoutbox server's channels — this is the authoritative
        //    source of the channel's numeric `permissions`, which MessageInput
        //    needs to enable the composer.
        await useServerStore.getState().fetchServers();
        const channels = await useServerStore.getState().fetchChannels(serverId);
        const channel = channels.find((c) => c.id === channelId) ?? null;
        const server = useServerStore.getState().servers.find((sv) => sv.id === serverId) ?? null;
        useServerStore.setState({ activeServer: server, activeChannel: channel });
        useServerStore.getState().fetchEmojis(serverId).catch(() => {});
        useAppConfigStore.getState().fetchConfig().catch(() => {});

        // 5. Typing indicator: register the one listener useSignalRListeners
        //    would normally own, and tell presenceStore which channel is active
        //    (addTypingUser early-returns otherwise).
        const conn = getConnection();
        conn.on('UserIsTyping', (cid: string, uid: string, dn: string) => {
          usePresenceStore.getState().addTypingUser(cid, uid, dn);
        });
        usePresenceStore.getState().setTypingChannel(channelId);

        // 6. Join the channel group + load history (the work ChannelSidebar
        //    normally does on channel switch).
        await useMessageStore.getState().joinChannel(channelId);
        await useMessageStore.getState().fetchMessages(channelId);

        // 7. Re-join on reconnect (we skip the heavy useSignalRListeners which
        //    normally handles this).
        onReconnected(() => {
          useMessageStore.getState().joinChannel(channelId).catch(() => {});
          usePresenceStore.getState().setTypingChannel(channelId);
        });

        if (!cancelled) setPhase('ready');
      } catch (err: any) {
        if (cancelled) return;
        const status = err?.response?.status;
        setPhase(status === 400 || status === 401 || status === 403 ? 'unauthenticated' : 'error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === 'loading') {
    return <div className="shoutbox-widget shoutbox-status">Connecting…</div>;
  }
  if (phase === 'unauthenticated') {
    return (
      <div className="shoutbox-widget">
        <LoginPlaceholder />
      </div>
    );
  }
  if (phase === 'error') {
    return <div className="shoutbox-widget shoutbox-status">Could not connect to chat.</div>;
  }

  return (
    <div className="shoutbox-widget">
      <ShoutboxHeader name={activeChannel?.name ?? 'Shoutbox'} />
      <MessageList />
      <TypingIndicator />
      <MessageInput />
      <ToastHost />
    </div>
  );
}
