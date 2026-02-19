import * as signalR from "@microsoft/signalr";
import { getApiBase, ensureFreshToken } from "./api.js";
import { useSignalRStore, type SignalRStatus } from "../stores/signalrStore.js";

const HEALTH_INTERVAL_MS = 30000;
const PING_TIMEOUT_MS = 8000;
const RECONNECT_GRACE_MS = 20000;
const PING_FAIL_THRESHOLD = 2;

let connection: signalR.HubConnection | null = null;
let startPromise: Promise<signalR.HubConnection> | null = null;
let healthInterval: ReturnType<typeof setInterval> | null = null;
let reconnectingSince: number | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let pingInFlight = false;
let consecutivePingFailures = 0;
let reconnectCallbacks: (() => void)[] = [];
let suspended = false;
let intentionalStop = false;

export function onReconnected(cb: () => void): () => void {
  reconnectCallbacks.push(cb);
  return () => {
    reconnectCallbacks = reconnectCallbacks.filter((c) => c !== cb);
  };
}

function fireReconnectCallbacks() {
  for (const cb of reconnectCallbacks) cb();
}

function setStatus(status: SignalRStatus, lastError?: string | null) {
  useSignalRStore.getState().setStatus(status, lastError ?? null);
}

export function getConnection(): signalR.HubConnection {
  if (connection) return connection;

  connection = new signalR.HubConnectionBuilder()
    .withUrl(`${getApiBase()}/hubs/chat`, {
      accessTokenFactory: async () => (await ensureFreshToken()) || "",
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 20000, 30000])
    .build();

  connection.keepAliveIntervalInMilliseconds = 15000;
  connection.serverTimeoutInMilliseconds = 60000;

  connection.onreconnecting((err) => {
    console.warn('[SignalR] onreconnecting', err?.message ?? '(no error)');
    reconnectingSince = Date.now();
    setStatus("reconnecting");
  });

  connection.onreconnected(() => {
    console.log('[SignalR] onreconnected');
    reconnectingSince = null;
    reconnectAttempts = 0;
    consecutivePingFailures = 0;
    setStatus("connected");
    fireReconnectCallbacks();
  });

  connection.onclose((err) => {
    console.warn('[SignalR] onclose', err?.message ?? '(no error)', intentionalStop ? '(intentional)' : '');
    reconnectingSince = null;
    if (intentionalStop) {
      // restartConnection is handling the stop+start cycle — don't interfere
      return;
    }
    setStatus("disconnected");
    if (!suspended) {
      scheduleReconnect("closed");
    }
  });

  return connection;
}

export function startConnection(): Promise<signalR.HubConnection> {
  suspended = false;
  const conn = getConnection();
  if (conn.state === signalR.HubConnectionState.Connected) {
    return Promise.resolve(conn);
  }
  // If the library is auto-reconnecting, wait for it to finish instead of
  // calling start() (which would throw "not in Disconnected state").
  if (conn.state === signalR.HubConnectionState.Reconnecting) {
    if (!startPromise) {
      startPromise = new Promise<signalR.HubConnection>((resolve, reject) => {
        const unsub = onReconnected(() => {
          unsub();
          startPromise = null;
          resolve(conn);
        });
        // If reconnection fails and connection closes, the onclose handler
        // will call scheduleReconnect which eventually calls startConnection
        // again. Time-box the wait so callers aren't stuck forever.
        setTimeout(() => {
          unsub();
          if (startPromise) {
            startPromise = null;
            reject(new Error("Timed out waiting for reconnect"));
          }
        }, 30000);
      });
    }
    return startPromise;
  }
  setStatus("connecting");
  if (!startPromise) {
    startPromise = conn
      .start()
      .then(() => {
        startPromise = null;
        startHealthMonitor();
        setStatus("connected");
        return conn;
      })
      .catch((err) => {
        startPromise = null;
        setStatus("disconnected", err instanceof Error ? err.message : null);
        throw err;
      });
  }
  return startPromise;
}

export function ensureConnected(): Promise<signalR.HubConnection> {
  return startConnection();
}

export async function stopConnection(): Promise<void> {
  startPromise = null;
  stopHealthMonitor();
  clearReconnectTimer();
  if (connection) {
    await connection.stop();
    connection = null;
  }
  setStatus("disconnected");
}

export async function suspendConnection(): Promise<void> {
  startPromise = null;
  stopHealthMonitor();
  clearReconnectTimer();
  suspended = true;
  if (connection) {
    try {
      await connection.stop();
    } catch {
      // ignore
    }
  }
  setStatus("disconnected");
}

export function resetConnection(): void {
  startPromise = null;
  stopHealthMonitor();
  clearReconnectTimer();
  connection = null;
  setStatus("disconnected");
}

async function restartConnection(reason: string): Promise<void> {
  const conn = getConnection();
  console.log(`[SignalR] restartConnection reason=${reason} state=${conn.state}`);
  // Don't skip when state is "Connected" — the connection may be a zombie
  // (SignalR thinks it's connected but the underlying transport is dead).
  // The health check only triggers a restart after confirmed ping failures,
  // so forcing a stop+start here is intentional.
  setStatus("reconnecting");
  stopHealthMonitor();
  intentionalStop = true;
  try {
    await conn.stop();
  } catch {
    // Ignore stop errors; we'll attempt a clean start anyway.
  } finally {
    intentionalStop = false;
  }
  // Ensure the access token is still valid before reconnecting — only refreshes
  // if near expiry, avoiding unnecessary API calls that could fail during restarts.
  await ensureFreshToken().catch(() => {});
  try {
    await startConnection();
    console.log('[SignalR] restartConnection succeeded');
    fireReconnectCallbacks();
  } catch (err) {
    console.warn('[SignalR] restartConnection failed', (err as Error)?.message);
    scheduleReconnect(`restart-failed:${reason}`);
    throw err;
  }
}

function startHealthMonitor() {
  if (healthInterval) return;
  healthInterval = setInterval(() => {
    // Skip health checks while the window is hidden — browsers throttle
    // WebSocket traffic and timers for background tabs, causing false
    // positive ping timeouts.
    if (typeof document !== "undefined" && document.hidden) return;
    void healthCheck();
  }, HEALTH_INTERVAL_MS);
}

function stopHealthMonitor() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

// When the window becomes visible again, run an immediate health check
// and reset ping failure state (failures while hidden are unreliable).
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && healthInterval && connection) {
      consecutivePingFailures = 0;
      void healthCheck();
    }
  });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(reason: string) {
  if (reconnectTimer) return;
  console.warn(`[SignalR] scheduleReconnect reason=${reason} attempt=${reconnectAttempts}`);
  setStatus("reconnecting", reason);
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void restartConnection(reason).catch(() => {
      scheduleReconnect("retry");
    });
  }, delay);
}

export async function healthCheck() {
  const conn = getConnection();
  if (conn.state !== signalR.HubConnectionState.Connected) {
    console.debug(`[SignalR] healthCheck state=${conn.state}`);
  }
  if (conn.state === signalR.HubConnectionState.Disconnected) {
    scheduleReconnect("disconnected");
    return;
  }
  if (
    conn.state === signalR.HubConnectionState.Reconnecting &&
    reconnectingSince
  ) {
    if (Date.now() - reconnectingSince > RECONNECT_GRACE_MS) {
      scheduleReconnect("reconnecting-timeout");
    }
    return;
  }
  if (conn.state !== signalR.HubConnectionState.Connected) return;
  if (pingInFlight) return;
  const hidden = typeof document !== "undefined" && document.hidden;
  if (hidden) {
    console.debug('[SignalR] skipping ping (document hidden)');
    return;
  }
  pingInFlight = true;
  const pingStart = Date.now();
  console.debug(`[SignalR] ping start state=${conn.state} hidden=${hidden}`);
  try {
    await Promise.race([
      conn.invoke("Ping"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Ping timeout")), PING_TIMEOUT_MS),
      ),
    ]);
    console.debug(`[SignalR] ping ok ${Date.now() - pingStart}ms`);
    consecutivePingFailures = 0;
  } catch (err) {
    consecutivePingFailures += 1;
    console.warn(`[SignalR] ping failed ${Date.now() - pingStart}ms failures=${consecutivePingFailures}/${PING_FAIL_THRESHOLD} state=${conn.state}`, (err as Error)?.message);
    if (consecutivePingFailures >= PING_FAIL_THRESHOLD) {
      consecutivePingFailures = 0;
      scheduleReconnect("ping-failed");
    }
  } finally {
    pingInFlight = false;
  }
}

/**
 * Quick connection check for window focus events.
 * Single ping with short timeout — if it fails, restart immediately.
 * Returns true if the connection is alive, false if a restart was triggered.
 */
export async function focusReconnect(): Promise<boolean> {
  const conn = getConnection();
  if (conn.state !== signalR.HubConnectionState.Connected) {
    if (conn.state === signalR.HubConnectionState.Disconnected) {
      scheduleReconnect("focus-disconnected");
    }
    return false;
  }
  try {
    await Promise.race([
      conn.invoke("Ping"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Ping timeout")), PING_TIMEOUT_MS),
      ),
    ]);
    console.debug('[SignalR] focus ping ok');
    consecutivePingFailures = 0;
    return true;
  } catch {
    console.warn('[SignalR] focus ping failed — restarting');
    consecutivePingFailures = 0;
    // Restart immediately, no delay
    void restartConnection("focus-ping-failed").catch(() => {
      scheduleReconnect("focus-restart-failed");
    });
    return false;
  }
}
