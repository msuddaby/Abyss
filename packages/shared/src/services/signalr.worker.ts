// SignalR Web Worker — owns the real HubConnection.
// Runs in a separate thread so Chrome doesn't throttle timers/WebSockets
// when the tab is backgrounded.

import * as signalR from '@microsoft/signalr';
import { ALL_SIGNALR_EVENTS } from './signalr.protocol.js';
import type { MainToWorkerMessage, WorkerToMainMessage } from './signalr.protocol.js';

// ── Constants ────────────────────────────────────────────────────────────────

const HEALTH_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 4_000;
const RECONNECT_GRACE_MS = 20_000;
const PING_FAIL_THRESHOLD = 2;
const STALE_THRESHOLD_MS = 45_000;

// ── State ────────────────────────────────────────────────────────────────────

let connection: signalR.HubConnection | null = null;
let healthInterval: ReturnType<typeof setInterval> | null = null;
let reconnectingSince: number | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let pingInFlight = false;
let consecutivePingFailures = 0;
let suspended = false;
let intentionalStop = false;
let lastActivity = 0;
let restartPromise: Promise<void> | null = null;
let documentHidden = false;

// Token handshake: worker asks main thread for a token, main thread replies
let pendingTokenResolve: ((token: string) => void) | null = null;
let tokenRequestId = 0;

// Hub URL — set by 'init' message
let hubUrl = '';

// ── Helpers ──────────────────────────────────────────────────────────────────

function post(msg: WorkerToMainMessage): void {
  self.postMessage(msg);
}

function log(level: 'log' | 'warn' | 'debug', message: string): void {
  // Skip debug logs while hidden to reduce postMessage traffic
  if (documentHidden && level === 'debug') return;
  post({ type: 'log', level, message });
}

function postState(): void {
  post({ type: 'state-change', state: connection?.state ?? 'Disconnected' });
}

function toErrorMessage(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

async function accessTokenFactory(): Promise<string> {
  return new Promise((resolve) => {
    const id = ++tokenRequestId;
    pendingTokenResolve = resolve;
    post({ type: 'token-request', id });
  });
}

// ── Connection management ────────────────────────────────────────────────────

function createConnection(): signalR.HubConnection {
  if (connection) return connection;

  connection = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl, { accessTokenFactory })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 20000, 30000])
    .build();

  // Match the server's KeepAliveInterval (30s) and ClientTimeoutInterval (120s).
  // The client's serverTimeout must be >= 2× the server's KeepAliveInterval.
  connection.keepAliveIntervalInMilliseconds = 30_000;
  connection.serverTimeoutInMilliseconds = 120_000;

  // Pre-register all events so they get forwarded to the main thread.
  // When the document is hidden, skip forwarding to avoid building up a
  // postMessage backlog (Firefox throttles worker→main delivery for
  // backgrounded tabs). The main thread's visibility-change refresh will
  // catch up on missed state.
  for (const name of ALL_SIGNALR_EVENTS) {
    connection.on(name, (...args: unknown[]) => {
      if (documentHidden) return;
      post({ type: 'event', name, args });
    });
  }

  connection.onreconnecting((err) => {
    log('warn', `[SignalR Worker] onreconnecting: ${err?.message ?? '(no error)'}`);
    reconnectingSince = Date.now();
    post({ type: 'reconnecting', error: toErrorMessage(err) });
    post({ type: 'state-change', state: 'Reconnecting' });
  });

  connection.onreconnected(() => {
    log('log', '[SignalR Worker] onreconnected');
    reconnectingSince = null;
    reconnectAttempts = 0;
    consecutivePingFailures = 0;
    lastActivity = Date.now();
    post({ type: 'reconnected' });
    post({ type: 'state-change', state: 'Connected' });
  });

  connection.onclose((err) => {
    reconnectingSince = null;
    if (intentionalStop) {
      log('debug', '[SignalR Worker] onclose (intentional)');
      post({ type: 'closed', error: toErrorMessage(err), intentional: true });
      return;
    }
    log('warn', `[SignalR Worker] onclose (unexpected, hidden=${documentHidden}, suspended=${suspended}): ${err?.message ?? '(no error)'}`);
    post({ type: 'closed', error: toErrorMessage(err), intentional: false });
    post({ type: 'state-change', state: 'Disconnected' });
    if (!suspended) {
      scheduleReconnect('closed');
    }
  });

  return connection;
}

async function startConnection(): Promise<void> {
  suspended = false;
  const conn = createConnection();

  if (conn.state === signalR.HubConnectionState.Connected) return;

  if (conn.state === signalR.HubConnectionState.Reconnecting) {
    // Wait for auto-reconnect to finish
    await new Promise<void>((resolve, reject) => {
      const onReconn = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('Connection closed while reconnecting')); };
      const cleanup = () => {
        // Remove these one-shot listeners — can't use off() with anonymous fns
        // so we just let them become no-ops via the resolved flag
      };
      let resolved = false;
      connection!.onreconnected(() => { if (!resolved) { resolved = true; onReconn(); } });
      setTimeout(() => { if (!resolved) { resolved = true; onClose(); } }, 30000);
    });
    return;
  }

  await conn.start();
  lastActivity = Date.now();
  startHealthMonitor();
  post({ type: 'state-change', state: 'Connected' });
}

async function stopConnection(): Promise<void> {
  stopHealthMonitor();
  clearReconnectTimer();
  if (connection) {
    await connection.stop();
    connection = null;
  }
  post({ type: 'state-change', state: 'Disconnected' });
}

async function suspendConnection(): Promise<void> {
  stopHealthMonitor();
  clearReconnectTimer();
  suspended = true;
  if (connection) {
    try { await connection.stop(); } catch { /* ignore */ }
  }
  post({ type: 'state-change', state: 'Disconnected' });
}

function resetConnectionState(): void {
  stopHealthMonitor();
  clearReconnectTimer();
  connection = null;
  post({ type: 'state-change', state: 'Disconnected' });
}

async function restartConnection(reason: string): Promise<void> {
  if (restartPromise) {
    log('warn', `[SignalR Worker] restartConnection: joining existing restart (reason=${reason})`);
    return restartPromise;
  }

  restartPromise = (async () => {
    const conn = createConnection();
    log('warn', `[SignalR Worker] restartConnection begin reason=${reason} state=${conn.state}`);
    post({ type: 'state-change', state: 'Reconnecting' });
    stopHealthMonitor();
    intentionalStop = true;
    try {
      await conn.stop();
    } catch (err) {
      log('warn', `[SignalR Worker] restartConnection stop failed: ${toErrorMessage(err)}`);
    } finally {
      intentionalStop = false;
    }
    // Refresh token before reconnecting
    await accessTokenFactory().catch((err: unknown) => {
      log('warn', `[SignalR Worker] token refresh failed during restart: ${toErrorMessage(err)}`);
    });
    try {
      await startConnection();
      log('log', `[SignalR Worker] restartConnection succeeded reason=${reason}`);
      post({ type: 'reconnected' });
    } catch (err) {
      log('warn', `[SignalR Worker] restartConnection failed reason=${reason}: ${toErrorMessage(err)}`);
      scheduleReconnect(`restart-failed:${reason}`);
      throw err;
    }
  })().finally(() => {
    restartPromise = null;
  });

  return restartPromise;
}

// ── Health monitoring ────────────────────────────────────────────────────────
// Runs in the worker thread — NOT throttled by Chrome when the tab is hidden.

function startHealthMonitor(): void {
  if (healthInterval) return;
  healthInterval = setInterval(() => {
    void healthCheck();
  }, HEALTH_INTERVAL_MS);
}

function stopHealthMonitor(): void {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(reason: string): void {
  if (restartPromise) return;
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
  if (reconnectTimer) return;
  log('warn', `[SignalR Worker] scheduleReconnect reason=${reason} attempt=${reconnectAttempts} delayMs=${delay}`);
  post({ type: 'state-change', state: 'Reconnecting' });
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void restartConnection(reason).catch(() => {
      scheduleReconnect('retry');
    });
  }, delay);
}

async function healthCheck(): Promise<void> {
  const conn = connection;
  if (!conn) return;

  const isHidden = documentHidden;

  if (conn.state === signalR.HubConnectionState.Disconnected) {
    if (!isHidden) scheduleReconnect('disconnected');
    return;
  }
  if (conn.state === signalR.HubConnectionState.Reconnecting && reconnectingSince) {
    if (!isHidden && Date.now() - reconnectingSince > RECONNECT_GRACE_MS) {
      scheduleReconnect('reconnecting-timeout');
    }
    return;
  }
  if (conn.state !== signalR.HubConnectionState.Connected) return;
  if (pingInFlight) return;

  pingInFlight = true;
  const pingStart = Date.now();
  log('debug', `[SignalR Worker] ping start hidden=${isHidden} connState=${conn.state}`);

  // Run the invoke and timeout as separate promises so we can tell which one won
  let pingResult: 'ok' | 'invoke-error' | 'timeout' = 'timeout';
  let pingError: unknown = null;
  const invokePromise = conn.invoke('Ping').then(
    () => { pingResult = 'ok'; },
    (err: unknown) => { pingResult = 'invoke-error'; pingError = err; throw err; },
  );
  try {
    await Promise.race([
      invokePromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Ping timeout')), PING_TIMEOUT_MS),
      ),
    ]);
    const elapsed = Date.now() - pingStart;
    log(isHidden ? 'warn' : 'debug', `[SignalR Worker] ping ok ${elapsed}ms hidden=${isHidden}`);
    lastActivity = Date.now();
    consecutivePingFailures = 0;
  } catch (err) {
    if (intentionalStop) {
      pingInFlight = false;
      return;
    }
    const elapsed = Date.now() - pingStart;
    const detail = `${elapsed}ms result=${pingResult} connState=${conn.state} error=${toErrorMessage(pingError ?? err)}`;
    if (isHidden) {
      log('warn', `[SignalR Worker] BACKGROUND ping failed ${detail} (diagnostic only, not counting)`);
    } else {
      consecutivePingFailures += 1;
      log('warn', `[SignalR Worker] ping failed ${detail} failures=${consecutivePingFailures}/${PING_FAIL_THRESHOLD}`);
      if (consecutivePingFailures >= PING_FAIL_THRESHOLD) {
        consecutivePingFailures = 0;
        scheduleReconnect('ping-failed');
      }
    }
  } finally {
    pingInFlight = false;
  }
}

async function focusReconnect(id: number, restartOnFailure: boolean): Promise<void> {
  const conn = connection;
  log('warn', `[SignalR Worker] focusReconnect start connState=${conn?.state ?? 'null'} pingInFlight=${pingInFlight}`);
  if (!conn || conn.state !== signalR.HubConnectionState.Connected) {
    if (conn?.state === signalR.HubConnectionState.Disconnected) {
      scheduleReconnect('focus-disconnected');
    }
    post({ type: 'focus-reconnect-result', id, alive: false });
    return;
  }
  const pingStart = Date.now();
  try {
    await Promise.race([
      conn.invoke('Ping'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Ping timeout')), PING_TIMEOUT_MS),
      ),
    ]);
    log('warn', `[SignalR Worker] focusReconnect ping ok ${Date.now() - pingStart}ms`);
    consecutivePingFailures = 0;
    lastActivity = Date.now();
    post({ type: 'focus-reconnect-result', id, alive: true });
  } catch (err) {
    log('warn', `[SignalR Worker] focusReconnect ping failed ${Date.now() - pingStart}ms connState=${conn.state} error=${toErrorMessage(err)}`);
    consecutivePingFailures = 0;
    if (restartOnFailure) {
      void restartConnection('focus-ping-failed').catch(() => {
        scheduleReconnect('focus-restart-failed');
      });
    }
    post({ type: 'focus-reconnect-result', id, alive: false });
  }
}

async function ensureConnected(id: number): Promise<void> {
  const conn = connection;
  if (conn?.state === signalR.HubConnectionState.Connected) {
    if (lastActivity > 0 && Date.now() - lastActivity < STALE_THRESHOLD_MS) {
      post({ type: 'ensure-connected-result', id, ok: true });
      return;
    }
    // Stale — ping to verify
    try {
      await Promise.race([
        conn.invoke('Ping'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Stale ping timeout')), 3000),
        ),
      ]);
      lastActivity = Date.now();
      post({ type: 'ensure-connected-result', id, ok: true });
      return;
    } catch {
      log('warn', '[SignalR Worker] ensureConnected: stale connection, restarting');
      await restartConnection('stale-zombie');
      post({ type: 'ensure-connected-result', id, ok: true });
      return;
    }
  }
  try {
    await startConnection();
    post({ type: 'ensure-connected-result', id, ok: true });
  } catch (err) {
    post({ type: 'ensure-connected-result', id, ok: false, error: toErrorMessage(err) ?? 'Start failed' });
  }
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      hubUrl = `${msg.url}${msg.hubPath}`;
      log('log', `[SignalR Worker] initialized with hub URL: ${hubUrl}`);
      break;

    case 'start':
      void (async () => {
        try {
          await startConnection();
          post({ type: 'started' });
        } catch (err) {
          post({ type: 'start-error', error: toErrorMessage(err) ?? 'Start failed' });
        }
      })();
      break;

    case 'stop':
      void (async () => {
        try {
          await stopConnection();
        } catch { /* ignore */ }
        post({ type: 'stopped' });
      })();
      break;

    case 'suspend':
      void suspendConnection();
      break;

    case 'reset':
      resetConnectionState();
      break;

    case 'invoke': {
      const { id, method, args } = msg;
      const conn = connection;
      if (!conn || conn.state !== signalR.HubConnectionState.Connected) {
        post({ type: 'invoke-result', id, ok: false, error: `Cannot invoke '${method}': not connected (state=${conn?.state ?? 'null'})` });
        break;
      }
      conn.invoke(method, ...args)
        .then((result) => post({ type: 'invoke-result', id, ok: true, result }))
        .catch((err) => post({ type: 'invoke-result', id, ok: false, error: toErrorMessage(err) ?? 'Invoke failed' }));
      break;
    }

    case 'token-response':
      if (pendingTokenResolve) {
        pendingTokenResolve(msg.token);
        pendingTokenResolve = null;
      }
      break;

    case 'visibility-change': {
      const wasHidden = documentHidden;
      documentHidden = msg.hidden;
      if (wasHidden && !documentHidden && connection) {
        log('warn', `[SignalR Worker] tab became visible — connState=${connection.state} lastActivity=${Date.now() - lastActivity}ms ago pingInFlight=${pingInFlight}`);
        consecutivePingFailures = 0;
        // Don't fire healthCheck() here — the main thread sends a focus-reconnect
        // message right after visibility change, which does its own ping. Firing
        // both creates a double-ping race and wastes a serialized invocation slot.
      }
      break;
    }

    case 'focus-reconnect':
      void focusReconnect(msg.id, msg.restartOnFailure);
      break;

    case 'ensure-connected':
      void ensureConnected(msg.id);
      break;
  }
};

log('log', '[SignalR Worker] ready');
