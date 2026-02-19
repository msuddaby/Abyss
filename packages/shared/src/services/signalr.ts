import * as signalR from "@microsoft/signalr";
import { getApiBase, ensureFreshToken } from "./api.js";
import { useSignalRStore, type SignalRStatus } from "../stores/signalrStore.js";

const HEALTH_INTERVAL_MS = 30000;
const PING_TIMEOUT_MS = 8000;
const RECONNECT_GRACE_MS = 20000;

let connection: signalR.HubConnection | null = null;
let startPromise: Promise<signalR.HubConnection> | null = null;
let healthInterval: ReturnType<typeof setInterval> | null = null;
let reconnectingSince: number | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let pingInFlight = false;
let reconnectCallbacks: (() => void)[] = [];
let suspended = false;

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

  connection.onreconnecting(() => {
    reconnectingSince = Date.now();
    setStatus("reconnecting");
  });

  connection.onreconnected(() => {
    reconnectingSince = null;
    reconnectAttempts = 0;
    setStatus("connected");
    fireReconnectCallbacks();
  });

  connection.onclose(() => {
    reconnectingSince = null;
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
  if (conn.state === signalR.HubConnectionState.Connected) return;
  setStatus("reconnecting");
  try {
    await conn.stop();
  } catch {
    // Ignore stop errors; we'll attempt a clean start anyway.
  }
  // Ensure the access token is still valid before reconnecting — only refreshes
  // if near expiry, avoiding unnecessary API calls that could fail during restarts.
  await ensureFreshToken().catch(() => {});
  try {
    await startConnection();
    fireReconnectCallbacks();
  } catch (err) {
    scheduleReconnect(`restart-failed:${reason}`);
    throw err;
  }
}

function startHealthMonitor() {
  if (healthInterval) return;
  healthInterval = setInterval(() => {
    void healthCheck();
  }, HEALTH_INTERVAL_MS);
}

function stopHealthMonitor() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(reason: string) {
  if (reconnectTimer) return;
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

async function healthCheck() {
  const conn = getConnection();
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
  pingInFlight = true;
  try {
    await Promise.race([
      conn.invoke("Ping"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Ping timeout")), PING_TIMEOUT_MS),
      ),
    ]);
  } catch {
    scheduleReconnect("ping-failed");
  } finally {
    pingInFlight = false;
  }
}
