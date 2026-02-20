import * as signalR from "@microsoft/signalr";
import { getApiBase, ensureFreshToken } from "./api.js";
import { useSignalRStore, type SignalRStatus } from "../stores/signalrStore.js";
import { useVoiceStore } from "../stores/voiceStore.js";

const HEALTH_INTERVAL_MS = 30000;
const PING_TIMEOUT_MS = 4000;
const RECONNECT_GRACE_MS = 20000;
const PING_FAIL_THRESHOLD = 2;
const STALE_THRESHOLD_MS = 45000;
const INVOKE_TIMEOUT_MS = 5000;

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
let lastActivity = 0;
let networkDebounce: ReturnType<typeof setTimeout> | null = null;
let restartPromise: Promise<void> | null = null;
let restartInFlightReason: string | null = null;
let reconnectDebugSeq = 0;

export interface SignalRReconnectDebugInfo {
  seq: number;
  trigger: string;
  detail: string;
  state: string;
  hidden: boolean;
  inVoiceCall: boolean;
  atIso: string;
  error: string | null;
}

let lastReconnectDebugInfo: SignalRReconnectDebugInfo | null = null;

function toErrorMessage(err: unknown): string {
  if (!err) return "(no error)";
  if (err instanceof Error) return err.stack ? `${err.name}: ${err.message}` : err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function recordReconnectDebug(
  trigger: string,
  detail: string,
  options?: {
    err?: unknown;
    level?: "log" | "warn" | "debug";
    conn?: signalR.HubConnection | null;
  },
): SignalRReconnectDebugInfo {
  const conn = options?.conn ?? connection;
  const info: SignalRReconnectDebugInfo = {
    seq: ++reconnectDebugSeq,
    trigger,
    detail,
    state: conn ? String(conn.state) : "NotCreated",
    hidden: typeof document !== "undefined" ? document.hidden : false,
    inVoiceCall: !!useVoiceStore.getState().currentChannelId,
    atIso: new Date().toISOString(),
    error: options?.err ? toErrorMessage(options.err) : null,
  };
  lastReconnectDebugInfo = info;
  const line = `[SignalR][diag#${info.seq}] trigger=${info.trigger} detail=${info.detail} state=${info.state} hidden=${info.hidden} inVoiceCall=${info.inVoiceCall}${info.error ? ` error=${info.error}` : ""}`;
  const level = options?.level ?? "log";
  if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);
  return info;
}

export function getLastReconnectDebugInfo(): SignalRReconnectDebugInfo | null {
  return lastReconnectDebugInfo ? { ...lastReconnectDebugInfo } : null;
}

export function onReconnected(cb: () => void): () => void {
  reconnectCallbacks.push(cb);
  return () => {
    reconnectCallbacks = reconnectCallbacks.filter((c) => c !== cb);
  };
}

let lastReconnectFire = 0;
function fireReconnectCallbacks() {
  const now = Date.now();
  if (now - lastReconnectFire < 2000) return; // dedupe — restartConnection + onreconnected can both fire
  lastReconnectFire = now;
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
    recordReconnectDebug("signalr.onreconnecting", "automatic reconnect started", {
      err,
      level: "warn",
      conn: connection,
    });
    reconnectingSince = Date.now();
    setStatus("reconnecting");
  });

  connection.onreconnected(() => {
    const diag = getLastReconnectDebugInfo();
    console.log(`[SignalR] onreconnected${diag ? ` after diag#${diag.seq} (${diag.trigger}: ${diag.detail})` : ''}`);
    reconnectingSince = null;
    reconnectAttempts = 0;
    consecutivePingFailures = 0;
    lastActivity = Date.now();
    setStatus("connected");
    fireReconnectCallbacks();
  });

  connection.onclose((err) => {
    console.warn('[SignalR] onclose', err?.message ?? '(no error)', intentionalStop ? '(intentional)' : '');
    reconnectingSince = null;
    if (intentionalStop) {
      // restartConnection is handling the stop+start cycle — don't interfere
      recordReconnectDebug("signalr.onclose", "intentional close during restart", {
        err,
        level: "debug",
        conn: connection,
      });
      return;
    }
    recordReconnectDebug("signalr.onclose", `unexpected close (suspended=${suspended})`, {
      err,
      level: "warn",
      conn: connection,
    });
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
        lastActivity = Date.now();
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

export async function ensureConnected(): Promise<signalR.HubConnection> {
  const conn = getConnection();
  if (conn.state === signalR.HubConnectionState.Connected) {
    // Fast path: connected and fresh — no overhead
    if (lastActivity > 0 && Date.now() - lastActivity < STALE_THRESHOLD_MS) {
      return conn;
    }
    // Connected but stale — quick ping to verify it's not a zombie
    try {
      await Promise.race([
        conn.invoke("Ping"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Stale ping timeout")), 3000),
        ),
      ]);
      lastActivity = Date.now();
      return conn;
    } catch (err) {
      console.warn('[SignalR] ensureConnected: stale connection detected, restarting');
      recordReconnectDebug("ensureConnected", "stale ping failed -> restartConnection(stale-zombie)", {
        err,
        level: "warn",
        conn,
      });
      await restartConnection("stale-zombie");
      return getConnection();
    }
  }
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
  if (restartPromise) {
    recordReconnectDebug(
      "restartConnection",
      `join existing restart reason=${reason} inFlightReason=${restartInFlightReason ?? "unknown"}`,
      { level: "warn", conn: connection },
    );
    return restartPromise;
  }

  restartInFlightReason = reason;
  restartPromise = (async () => {
  const conn = getConnection();
  console.log(`[SignalR] restartConnection reason=${reason} state=${conn.state}`);
  recordReconnectDebug("restartConnection", `begin reason=${reason}`, {
    level: "warn",
    conn,
  });
  // Don't skip when state is "Connected" — the connection may be a zombie
  // (SignalR thinks it's connected but the underlying transport is dead).
  // The health check only triggers a restart after confirmed ping failures,
  // so forcing a stop+start here is intentional.
  setStatus("reconnecting");
  stopHealthMonitor();
  intentionalStop = true;
  try {
    await conn.stop();
  } catch (err) {
    recordReconnectDebug("restartConnection", `conn.stop failed reason=${reason}`, {
      err,
      level: "warn",
      conn,
    });
    // Ignore stop errors; we'll attempt a clean start anyway.
  } finally {
    intentionalStop = false;
  }
  // Ensure the access token is still valid before reconnecting — only refreshes
  // if near expiry, avoiding unnecessary API calls that could fail during restarts.
  await ensureFreshToken().catch((err) => {
    recordReconnectDebug("restartConnection", `ensureFreshToken failed reason=${reason}`, {
      err,
      level: "warn",
      conn,
    });
  });
  try {
    await startConnection();
    console.log(`[SignalR] restartConnection succeeded reason=${reason}`);
    fireReconnectCallbacks();
  } catch (err) {
    recordReconnectDebug("restartConnection", `failed reason=${reason}`, {
      err,
      level: "warn",
      conn,
    });
    console.warn('[SignalR] restartConnection failed', toErrorMessage(err));
    scheduleReconnect(`restart-failed:${reason}`);
    throw err;
  }
  })().finally(() => {
    recordReconnectDebug("restartConnection", `end reason=${reason}`, {
      level: "debug",
      conn: connection,
    });
    restartInFlightReason = null;
    restartPromise = null;
  });

  return restartPromise;
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
  if (restartPromise) {
    recordReconnectDebug("scheduleReconnect", `ignored reason=${reason} (restart in-flight: ${restartInFlightReason ?? "unknown"})`, {
      level: "debug",
      conn: connection,
    });
    return;
  }
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
  if (reconnectTimer) {
    recordReconnectDebug("scheduleReconnect", `ignored reason=${reason} (timer already scheduled)`, {
      level: "debug",
      conn: connection,
    });
    return;
  }
  console.warn(`[SignalR] scheduleReconnect reason=${reason} attempt=${reconnectAttempts} delayMs=${delay}`);
  recordReconnectDebug("scheduleReconnect", `reason=${reason} attempt=${reconnectAttempts} delayMs=${delay}`, {
    level: "warn",
    conn: connection,
  });
  setStatus("reconnecting", reason);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void restartConnection(reason).catch((err) => {
      recordReconnectDebug("scheduleReconnect", `restart failed in timer reason=${reason} -> schedule retry`, {
        err,
        level: "warn",
        conn: connection,
      });
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
    lastActivity = Date.now();
    consecutivePingFailures = 0;
  } catch (err) {
    // Ignore failures caused by an intentional restart tearing down the connection
    if (intentionalStop) {
      pingInFlight = false;
      return;
    }
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
 * Single ping with short timeout — optionally restarts on failure.
 * Returns true if the connection is alive, false if the ping failed.
 */
interface FocusReconnectOptions {
  restartOnFailure?: boolean;
}

export async function focusReconnect(options: FocusReconnectOptions = {}): Promise<boolean> {
  const { restartOnFailure = true } = options;
  const conn = getConnection();
  if (conn.state !== signalR.HubConnectionState.Connected) {
    recordReconnectDebug("focusReconnect", `connection not connected (state=${conn.state})`, {
      level: "warn",
      conn,
    });
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
    lastActivity = Date.now();
    return true;
  } catch (err) {
    consecutivePingFailures = 0;
    if (restartOnFailure) {
      console.warn('[SignalR] focus ping failed — restarting');
      recordReconnectDebug("focusReconnect", "ping failed -> forced restart", {
        err,
        level: "warn",
        conn,
      });
      // Restart immediately, no delay
      void restartConnection("focus-ping-failed").catch((restartErr) => {
        recordReconnectDebug("focusReconnect", "forced restart failed -> schedule reconnect", {
          err: restartErr,
          level: "warn",
          conn: connection,
        });
        scheduleReconnect("focus-restart-failed");
      });
    } else {
      console.warn('[SignalR] focus ping failed — skipping forced restart');
      recordReconnectDebug("focusReconnect", "ping failed but forced restart disabled", {
        err,
        level: "warn",
        conn,
      });
    }
    return false;
  }
}

/**
 * Resilient invoke — the single entry point for all user-facing SignalR calls.
 * 1. ensureConnected() (handles staleness detection)
 * 2. Invoke with timeout
 * 3. On failure: immediate restart + single retry
 */
export async function resilientInvoke(method: string, ...args: unknown[]): Promise<void> {
  const doInvoke = async () => {
    const conn = await ensureConnected();
    await Promise.race([
      conn.invoke(method, ...args),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Invoke timeout: ${method}`)), INVOKE_TIMEOUT_MS),
      ),
    ]);
    lastActivity = Date.now();
  };
  try {
    await doInvoke();
  } catch (err) {
    console.warn(`[SignalR] resilientInvoke ${method} failed, retrying`, (err as Error)?.message);
    recordReconnectDebug("resilientInvoke", `method=${method} invoke failed -> restart`, {
      err,
      level: "warn",
      conn: connection,
    });
    if (restartPromise) {
      recordReconnectDebug("resilientInvoke", `method=${method} waiting for in-flight restart (${restartInFlightReason ?? "unknown"})`, {
        level: "warn",
        conn: connection,
      });
      await restartPromise;
    } else {
      clearReconnectTimer();
      reconnectAttempts = 0;
      await restartConnection("invoke-failed");
    }
    try {
      await doInvoke();
    } catch (retryErr) {
      recordReconnectDebug("resilientInvoke", `method=${method} retry invoke failed`, {
        err: retryErr,
        level: "warn",
        conn: connection,
      });
      throw retryErr;
    }
  }
}

// --- Network change detection ---
function onNetworkChange(source: string) {
  if (suspended) return;
  if (networkDebounce) clearTimeout(networkDebounce);
  networkDebounce = setTimeout(() => {
    networkDebounce = null;
    console.log(`[SignalR] network change detected source=${source}, verifying connection`);
    const inActiveVoiceCall = !!useVoiceStore.getState().currentChannelId;
    recordReconnectDebug("network-change", `source=${source} -> focusReconnect restartOnFailure=${!inActiveVoiceCall}`, {
      level: "log",
      conn: connection,
    });
    void focusReconnect({ restartOnFailure: !inActiveVoiceCall });
  }, 2000);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => onNetworkChange("window.online"));
  // navigator.connection is not available in all browsers
  const nav = navigator as { connection?: EventTarget };
  nav.connection?.addEventListener("change", () => onNetworkChange("navigator.connection.change"));
}
