// SignalR facade — thin wrapper over a Web Worker that owns the real HubConnection.
// All health monitoring, ping checks, and reconnection logic live in the worker.
// This file handles: proxy lifecycle, token requests, resilientInvoke (voice-safe),
// onReconnected callbacks, visibility/network listeners, and debug info.

import { getApiBase, ensureFreshToken } from "./api.js";
import { useSignalRStore, type SignalRStatus } from "../stores/signalrStore.js";
import { useVoiceStore } from "../stores/voiceStore.js";
import { SignalRProxy } from "./signalr.proxy.js";
import type { SignalRConnection } from "./signalr.protocol.js";
import { reportDiagnostic } from "./diagnostics.js";

const INVOKE_TIMEOUT_MS = 5000;

// ── Proxy singleton ──────────────────────────────────────────────────────────

let proxy: SignalRProxy | null = null;
let startPromise: Promise<SignalRConnection> | null = null;
let reconnectCallbacks: (() => void)[] = [];
let suspended = false;
let networkDebounce: ReturnType<typeof setTimeout> | null = null;
let reconnectDebugSeq = 0;

// Fallback: direct HubConnection when Worker is unavailable
let directConnection: import("@microsoft/signalr").HubConnection | null = null;
let directHealthInterval: ReturnType<typeof setInterval> | null = null;
const supportsWorker = typeof Worker !== "undefined";

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

function recordDebug(
  trigger: string,
  detail: string,
  options?: { err?: unknown; level?: "log" | "warn" | "debug" },
): SignalRReconnectDebugInfo {
  const info: SignalRReconnectDebugInfo = {
    seq: ++reconnectDebugSeq,
    trigger,
    detail,
    state: proxy?.state ?? directConnection?.state ?? "NotCreated",
    hidden: typeof document !== "undefined" ? document.hidden : false,
    inVoiceCall: !!useVoiceStore.getState().currentChannelId,
    atIso: new Date().toISOString(),
    error: options?.err
      ? options.err instanceof Error
        ? options.err.message
        : String(options.err)
      : null,
  };
  lastReconnectDebugInfo = info;
  const line = `[SignalR][diag#${info.seq}] trigger=${info.trigger} detail=${info.detail} state=${info.state} hidden=${info.hidden} inVoiceCall=${info.inVoiceCall}${info.error ? ` error=${info.error}` : ""}`;
  const level = options?.level ?? "log";
  if (level === "warn") console.warn(line);
  else if (level === "debug") console.debug(line);
  else console.log(line);

  reportDiagnostic({
    category: 'signalr',
    message: `${info.trigger}: ${info.detail}`,
    level: level === 'warn' ? 'breadcrumb' : 'breadcrumb',
    data: { ...info },
    error: options?.err instanceof Error ? options.err : null,
  });

  return info;
}

export function getLastReconnectDebugInfo(): SignalRReconnectDebugInfo | null {
  return lastReconnectDebugInfo ? { ...lastReconnectDebugInfo } : null;
}

// ── Reconnected callbacks ────────────────────────────────────────────────────

export function onReconnected(cb: () => void): () => void {
  reconnectCallbacks.push(cb);
  return () => {
    reconnectCallbacks = reconnectCallbacks.filter((c) => c !== cb);
  };
}

let lastReconnectFire = 0;
function fireReconnectCallbacks() {
  const now = Date.now();
  if (now - lastReconnectFire < 2000) return;
  lastReconnectFire = now;
  for (const cb of reconnectCallbacks) cb();
}

function setStatus(status: SignalRStatus, lastError?: string | null) {
  useSignalRStore.getState().setStatus(status, lastError ?? null);
}

// ── Proxy / connection creation ──────────────────────────────────────────────

function getOrCreateProxy(): SignalRProxy {
  if (proxy) return proxy;

  const worker = new Worker(
    new URL("./signalr.worker.ts", import.meta.url),
    { type: "module" },
  );

  proxy = new SignalRProxy(worker);

  // Handle token requests from the worker
  proxy.onTokenRequest = (id) => {
    ensureFreshToken()
      .then((token) => proxy!.sendTokenResponse(id, token || ""))
      .catch(() => proxy!.sendTokenResponse(id, ""));
  };

  // Forward worker logs to console + diagnostics
  proxy.onLog = (level, message) => {
    if (level === "warn") console.warn(message);
    else if (level === "debug") console.debug(message);
    else console.log(message);

    // Forward worker-level logs as breadcrumbs so they appear in Sentry context
    if (level !== "debug") {
      reportDiagnostic({
        category: 'signalr',
        message,
        level: 'breadcrumb',
      });
    }
  };

  // Wire up lifecycle callbacks to status store
  proxy.onreconnecting((err) => {
    recordDebug("worker.onreconnecting", "automatic reconnect started", { err, level: "warn" });
    setStatus("reconnecting");
  });

  proxy.onreconnected(() => {
    recordDebug("worker.onreconnected", "reconnected", { level: "log" });
    setStatus("connected");
    fireReconnectCallbacks();
  });

  proxy.onclose((err) => {
    recordDebug("worker.onclose", `unexpected close (suspended=${suspended})`, {
      err,
      level: "warn",
    });
    if (err) {
      reportDiagnostic({
        category: 'signalr',
        message: `Connection closed unexpectedly: ${err}`,
        level: 'warning',
        data: { suspended, trigger: 'worker.onclose' },
        error: typeof err === 'string' ? new Error(err) : null,
      });
    }
    setStatus("disconnected");
  });

  // Initialize the worker with the hub URL
  // Workers have no window.location, so resolve empty base to an absolute origin
  const base = getApiBase() || (typeof location !== "undefined" ? location.origin : "");
  proxy.sendInit(base, "/hubs/chat");

  return proxy;
}

async function createDirectConnection(): Promise<import("@microsoft/signalr").HubConnection> {
  if (directConnection) return directConnection;

  const signalR = await import("@microsoft/signalr");
  directConnection = new signalR.HubConnectionBuilder()
    .withUrl(`${getApiBase()}/hubs/chat`, {
      accessTokenFactory: async () => (await ensureFreshToken()) || "",
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 20000, 30000])
    .build();

  directConnection.keepAliveIntervalInMilliseconds = 30_000;
  directConnection.serverTimeoutInMilliseconds = 120_000;

  directConnection.onreconnecting((err) => {
    recordDebug("direct.onreconnecting", "automatic reconnect started", { err, level: "warn" });
    setStatus("reconnecting");
  });

  directConnection.onreconnected(() => {
    recordDebug("direct.onreconnected", "reconnected", { level: "log" });
    setStatus("connected");
    fireReconnectCallbacks();
  });

  directConnection.onclose((err) => {
    recordDebug("direct.onclose", "connection closed", { err, level: "warn" });
    if (err) {
      reportDiagnostic({
        category: 'signalr',
        message: `Direct connection closed unexpectedly: ${err.message}`,
        level: 'warning',
        data: { trigger: 'direct.onclose' },
        error: err,
      });
    }
    setStatus("disconnected");
  });

  return directConnection;
}

// ── Exported API (same signatures as before) ─────────────────────────────────

export function getConnection(): SignalRConnection {
  if (supportsWorker) {
    return getOrCreateProxy();
  }
  // Fallback: return direct connection or a temporary object that will be replaced
  if (directConnection) return directConnection;
  // Create synchronously — caller will call startConnection() next
  // Return a placeholder that queues calls until the real connection is ready
  throw new Error("Call startConnection() before getConnection() in non-Worker environments");
}

export function startConnection(): Promise<SignalRConnection> {
  suspended = false;

  if (supportsWorker) {
    const p = getOrCreateProxy();
    if (p.state === "Connected") return Promise.resolve(p);
    if (!startPromise) {
      setStatus("connecting");
      startPromise = p
        .sendStart()
        .then(() => {
          startPromise = null;
          setStatus("connected");
          return p as SignalRConnection;
        })
        .catch((err) => {
          startPromise = null;
          setStatus("disconnected", err instanceof Error ? err.message : null);
          reportDiagnostic({
            category: 'signalr',
            message: `Connection start failed: ${err instanceof Error ? err.message : String(err)}`,
            level: 'error',
            data: { mode: 'worker' },
            error: err instanceof Error ? err : new Error(String(err)),
          });
          throw err;
        });
    }
    return startPromise;
  }

  // Fallback: direct connection
  if (!startPromise) {
    setStatus("connecting");
    startPromise = (async () => {
      const conn = await createDirectConnection();
      if (conn.state === "Connected") return conn;
      await conn.start();
      startDirectHealthMonitor();
      setStatus("connected");
      return conn;
    })()
      .catch((err) => {
        startPromise = null;
        setStatus("disconnected", err instanceof Error ? err.message : null);
        throw err;
      })
      .then((conn) => {
        startPromise = null;
        return conn;
      });
  }
  return startPromise;
}

export async function ensureConnected(): Promise<SignalRConnection> {
  if (supportsWorker) {
    const p = getOrCreateProxy();
    if (p.state === "Connected") {
      await p.sendEnsureConnected();
      return p;
    }
    await startConnection();
    return p;
  }

  // Fallback
  const conn = directConnection ?? (await createDirectConnection());
  if (conn.state === "Connected") return conn;
  return startConnection();
}

export async function stopConnection(): Promise<void> {
  startPromise = null;
  if (supportsWorker && proxy) {
    await proxy.sendStop();
  } else if (directConnection) {
    stopDirectHealthMonitor();
    await directConnection.stop();
    directConnection = null;
  }
  setStatus("disconnected");
}

export async function suspendConnection(): Promise<void> {
  startPromise = null;
  suspended = true;
  if (supportsWorker && proxy) {
    proxy.sendSuspend();
  } else if (directConnection) {
    stopDirectHealthMonitor();
    try { await directConnection.stop(); } catch { /* ignore */ }
  }
  setStatus("disconnected");
}

export function resetConnection(): void {
  startPromise = null;
  if (supportsWorker && proxy) {
    proxy.sendReset();
  } else {
    stopDirectHealthMonitor();
    directConnection = null;
  }
  setStatus("disconnected");
}

// ── Focus reconnect ──────────────────────────────────────────────────────────

interface FocusReconnectOptions {
  restartOnFailure?: boolean;
}

export async function focusReconnect(options: FocusReconnectOptions = {}): Promise<boolean> {
  const { restartOnFailure = true } = options;

  if (supportsWorker && proxy) {
    return proxy.sendFocusReconnect(restartOnFailure);
  }

  // Fallback: simple ping check
  if (!directConnection || directConnection.state !== "Connected") return false;
  try {
    await Promise.race([
      directConnection.invoke("Ping"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Ping timeout")), 4000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

// ── Health check (delegates to worker; no-op in worker mode) ─────────────────

export async function healthCheck(): Promise<void> {
  // In worker mode, health checks run in the worker automatically.
  // This export is kept for API compatibility.
  if (supportsWorker) return;

  // Fallback: basic health check
  if (!directConnection || directConnection.state !== "Connected") return;
  if (typeof document !== "undefined" && document.hidden) return;
  try {
    await Promise.race([
      directConnection.invoke("Ping"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Ping timeout")), 4000)),
    ]);
  } catch {
    // Auto-reconnect will handle it
  }
}

// ── Resilient invoke (voice-safe retry logic stays on main thread) ───────────

// Wait for the connection to be restored (reconnected event) with a timeout.
// Returns true if reconnected, false if timed out.
function waitForReconnection(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Already connected — no need to wait
    const state = supportsWorker ? proxy?.state : directConnection?.state;
    if (state === 'Connected') {
      resolve(true);
      return;
    }

    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      unsub();
      resolve(false);
    }, timeoutMs);

    const unsub = onReconnected(() => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      unsub();
      // Brief pause to let the connection stabilize
      setTimeout(() => resolve(true), 200);
    });
  });
}

export async function resilientInvoke(method: string, ...args: unknown[]): Promise<void> {
  const conn = supportsWorker ? getOrCreateProxy() : directConnection;
  if (!conn) throw new Error("Not connected");

  const doInvoke = async () => {
    // Skip the ensureConnected round-trip on the happy path — the worker
    // maintains the connection and the invoke will fail fast if it's dead.
    // This avoids an extra postMessage round-trip per call.
    await Promise.race([
      conn.invoke(method, ...args),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Invoke timeout: ${method}`)), INVOKE_TIMEOUT_MS),
      ),
    ]);
  };

  try {
    await doInvoke();
  } catch (err) {
    // First attempt failed — trigger reconnection and wait for it to complete
    // instead of a fixed delay. WebRTC voice is independent of SignalR so
    // restarting the SignalR connection won't disrupt active voice calls.
    console.warn(
      `[SignalR] resilientInvoke ${method} failed, waiting for reconnection`,
      (err as Error)?.message,
    );
    recordDebug(
      "resilientInvoke",
      `method=${method} invoke failed — waiting for reconnection`,
      { err, level: "warn" },
    );

    // Kick off reconnection in the worker
    if (supportsWorker) {
      try {
        await (conn as SignalRProxy).sendEnsureConnected();
      } catch {
        // Worker health checks will also detect and reconnect
      }
    }

    // Wait for the connection to actually be restored (up to 10s)
    const reconnected = await waitForReconnection(10_000);
    if (!reconnected) {
      reportDiagnostic({
        category: 'signalr',
        message: `Invoke failed, reconnection timed out: ${method}`,
        level: 'error',
        data: {
          method,
          error: err instanceof Error ? err.message : String(err),
        },
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw err;
    }

    try {
      await doInvoke();
    } catch (retryErr) {
      reportDiagnostic({
        category: 'signalr',
        message: `Invoke failed after reconnection retry: ${method}`,
        level: 'error',
        data: {
          method,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        },
        error: retryErr instanceof Error ? retryErr : new Error(String(retryErr)),
      });
      throw retryErr;
    }
  }
}

// ── Direct-mode health monitor (fallback only) ──────────────────────────────

function startDirectHealthMonitor() {
  if (directHealthInterval) return;
  directHealthInterval = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    void healthCheck();
  }, 30_000);
}

function stopDirectHealthMonitor() {
  if (directHealthInterval) {
    clearInterval(directHealthInterval);
    directHealthInterval = null;
  }
}

// ── Visibility + network listeners ───────────────────────────────────────────

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (supportsWorker && proxy) {
      proxy.sendVisibilityChange(document.hidden);
    }
  });

  // On Electron + Wayland, document.hidden never changes when the window is
  // minimized or hidden to tray — the Page Visibility API doesn't fire.
  // Use Electron's window focus events as an additional visibility signal.
  if (typeof window !== "undefined" && window.electron?.onWindowFocusChanged) {
    window.electron.onWindowFocusChanged((focused: boolean) => {
      if (supportsWorker && proxy) {
        proxy.sendVisibilityChange(!focused);
      }
    });
  }
}

function onNetworkChange(source: string) {
  if (suspended) return;
  if (networkDebounce) clearTimeout(networkDebounce);
  networkDebounce = setTimeout(() => {
    networkDebounce = null;
    console.log(`[SignalR] network change detected source=${source}, verifying connection`);
    recordDebug("network-change", `source=${source} -> focusReconnect restartOnFailure=true`, {
      level: "log",
    });
    // Always allow restart — WebRTC voice is independent of SignalR
    void focusReconnect({ restartOnFailure: true });
  }, 2000);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => onNetworkChange("window.online"));
  const nav = navigator as { connection?: EventTarget };
  nav.connection?.addEventListener("change", () => onNetworkChange("navigator.connection.change"));
}
