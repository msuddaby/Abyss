import api from './api.js';

export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
  ttlSeconds: number;
  expiresAtUtc: string;
}

type Listener = (creds: TurnCredentials) => void;

let cached: TurnCredentials | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<TurnCredentials> | null = null;
const listeners = new Set<Listener>();

const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MIN_REFRESH_DELAY_MS = 30 * 1000;
const RETRY_DELAY_MS = 15 * 1000;

function computeRefreshDelay(creds: TurnCredentials): number {
  const expiresAt = Date.parse(creds.expiresAtUtc);
  const ttlMs = creds.ttlSeconds * 1000;
  const skew = Math.max(DEFAULT_REFRESH_SKEW_MS, Math.floor(ttlMs * 0.2));
  const target = expiresAt - skew;
  const delay = target - Date.now();
  return Math.max(MIN_REFRESH_DELAY_MS, delay);
}

function clearRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(creds: TurnCredentials) {
  clearRefreshTimer();
  const delay = computeRefreshDelay(creds);
  refreshTimer = setTimeout(() => {
    void refreshTurnCredentials().catch(() => {
      // Retry soon if refresh failed
      clearRefreshTimer();
      refreshTimer = setTimeout(() => {
        void refreshTurnCredentials().catch(() => {});
      }, RETRY_DELAY_MS);
    });
  }, delay);
}

async function fetchTurnCredentials(): Promise<TurnCredentials> {
  const res = await api.get('/voice/turn');
  return res.data as TurnCredentials;
}

export async function refreshTurnCredentials(): Promise<TurnCredentials> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = fetchTurnCredentials()
    .then((creds) => {
      cached = creds;
      scheduleRefresh(creds);
      listeners.forEach((cb) => cb(creds));
      return creds;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export async function getTurnCredentials(): Promise<TurnCredentials> {
  if (cached) {
    const expiresAt = Date.parse(cached.expiresAtUtc);
    if (!Number.isNaN(expiresAt) && expiresAt > Date.now() + MIN_REFRESH_DELAY_MS) {
      return cached;
    }
  }
  return refreshTurnCredentials();
}

export function subscribeTurnCredentials(cb: Listener): () => void {
  listeners.add(cb);
  if (cached) cb(cached);
  return () => {
    listeners.delete(cb);
  };
}

export function clearTurnCredentials(): void {
  cached = null;
  clearRefreshTimer();
}
