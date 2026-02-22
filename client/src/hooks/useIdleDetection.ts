import { useEffect, useRef } from 'react';
import { useAuthStore, api, PresenceStatus, onReconnected, getConnection } from '@abyss/shared';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_TIMEOUT_S = IDLE_TIMEOUT_MS / 1000;
// How often to send ActivityHeartbeat to the server when user is active.
// This keeps _lastHeartbeats fresh so PresenceMonitorService doesn't mark
// the user as Away. Must be well under the server's 10-minute idle threshold.
const HEARTBEAT_THROTTLE_MS = 5 * 60 * 1000;

export function useIdleDetection() {
  const userId = useAuthStore((s) => s.user?.id);
  const presenceStatus = useAuthStore((s) => s.user?.presenceStatus);
  const token = useAuthStore((s) => s.token);
  const setPresenceStatus = useAuthStore((s) => s.setPresenceStatus);
  const autoAwayRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (presenceStatus === PresenceStatus.Away && !autoAwayRef.current) {
      // Server or idle timer set us to Away — adopt as auto-away so that
      // strong activity (mousemove, keydown, etc.) restores us to Online.
      autoAwayRef.current = true;
    } else if (autoAwayRef.current && presenceStatus !== PresenceStatus.Away) {
      autoAwayRef.current = false;
    }
  }, [presenceStatus]);

  useEffect(() => {
    if (!userId || !token) {
      autoAwayRef.current = false;
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      return;
    }

    let disposed = false;
    let lastHeartbeatSent = 0;
    // Track whether Electron's getSystemIdleTime() actually works.
    // On Linux Wayland it always returns 0 — we detect this and fall back
    // to the web timer. Once we see a value >= 5s, we know it works.
    // On Windows, it can return incorrect values when games are active.
    let systemIdleApiWorks = false;
    let lastIdleReadTime = Date.now();
    let lastIdleValue = 0;

    // Returns true if the API call succeeded (or was a no-op).
    const updatePresence = async (status: number): Promise<boolean> => {
      const currentStatus = useAuthStore.getState().user?.presenceStatus;
      if (currentStatus === status) return true;
      try {
        await api.put('/auth/presence', {
          presenceStatus: status
        }, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        if (!disposed) {
          setPresenceStatus(status);
        }
        return true;
      } catch (error) {
        console.error('Failed to update presence status:', error);
        return false;
      }
    };

    const markAwayIfEligible = async () => {
      const currentStatus = useAuthStore.getState().user?.presenceStatus;
      if (currentStatus !== PresenceStatus.Online) {
        console.log(`[IdleDetection] markAwayIfEligible: skipped (status=${currentStatus}, not Online)`);
        return;
      }

      console.log(`[IdleDetection] markAwayIfEligible: triggered (systemIdleApiWorks=${systemIdleApiWorks}, hasElectronApi=${typeof window.electron?.getSystemIdleTime === 'function'})`);

      // In Electron, check system-wide idle time before marking away.
      // This prevents false-away when the user is active in another app
      // (e.g. gaming). Skip the check if the API appears broken (Wayland/Windows issues).
      if (systemIdleApiWorks && typeof window.electron?.getSystemIdleTime === 'function') {
        try {
          const now = Date.now();
          const timeSinceLastRead = (now - lastIdleReadTime) / 1000;
          const sysIdleSec = await window.electron.getSystemIdleTime();
          console.log(`[IdleDetection] System idle check: ${sysIdleSec}s (threshold=${IDLE_TIMEOUT_S}s)`);
          lastIdleReadTime = now;

          // Validate the idle reading, especially on Windows where the API can be
          // unreliable when games are running and the window is minimized
          if (window.electron.platform === 'win32' && lastIdleValue > 0) {
            // If idle time jumped from active (<60s) to idle threshold (600s+) within
            // a short period, the reading is suspicious — likely a Windows idle bug
            const isSuspiciousJump = (
              lastIdleValue < 60 &&
              sysIdleSec >= IDLE_TIMEOUT_S &&
              timeSinceLastRead < 120
            );

            if (isSuspiciousJump) {
              console.warn(
                `[Idle] Ignoring suspicious Windows idle jump: ${lastIdleValue}s → ${sysIdleSec}s ` +
                `(Δt=${timeSinceLastRead.toFixed(1)}s). User likely active in another app.`
              );
              lastIdleValue = sysIdleSec;
              resetIdleTimer();
              sendActivityHeartbeat();
              return;
            }
          }

          lastIdleValue = sysIdleSec;

          if (sysIdleSec < IDLE_TIMEOUT_S) {
            // System is active — user is doing something else. Reset timer
            // and send a heartbeat so the server doesn't mark us away either.
            console.log(`[IdleDetection] System active (${sysIdleSec}s < ${IDLE_TIMEOUT_S}s) — resetting timer, NOT marking away`);
            resetIdleTimer();
            sendActivityHeartbeat();
            return;
          }
          console.log(`[IdleDetection] System idle confirmed (${sysIdleSec}s >= ${IDLE_TIMEOUT_S}s) — marking away`);
        } catch (e) {
          console.log('[IdleDetection] System idle check failed, falling through to mark away:', e);
        }
      } else {
        console.log(`[IdleDetection] No system idle check available — marking away based on renderer timer only`);
      }

      autoAwayRef.current = true;
      console.log('[IdleDetection] Setting status to Away');
      await updatePresence(PresenceStatus.Away);
    };

    let restoring = false;
    const restoreIfAutoAway = async () => {
      if (restoring) return; // already attempting
      const currentStatus = useAuthStore.getState().user?.presenceStatus;
      if (!autoAwayRef.current || currentStatus !== PresenceStatus.Away) return;
      restoring = true;
      try {
        const ok = await updatePresence(PresenceStatus.Online);
        if (ok) autoAwayRef.current = false;
        // If API failed, autoAwayRef stays true so next activity retries
      } finally {
        restoring = false;
      }
    };

    // Send a presence heartbeat to the server so PresenceMonitorService knows
    // the user is active. Throttled to avoid spamming on every mouse move.
    const sendActivityHeartbeat = () => {
      const now = Date.now();
      if (now - lastHeartbeatSent < HEARTBEAT_THROTTLE_MS) return;
      lastHeartbeatSent = now;
      console.log('[IdleDetection] Sending ActivityHeartbeat to server');
      try {
        const conn = getConnection();
        if (conn.state === 'Connected') {
          conn.invoke('ActivityHeartbeat').catch(() => {});
        }
      } catch {
        // Connection not ready — ignore
      }
    };

    // On macOS, powerMonitor.getSystemIdleTime() is reliable.
    // On Windows, it can be unreliable when games are active and window is minimized.
    // On Linux Wayland it always returns 0 — we probe to detect this and
    // fall back to the web timer. We probe a few times over 2 minutes;
    // if we ever see >= 5s, we know it works.
    let probeCount = 0;
    const MAX_PROBES = 4;
    let probeInterval: ReturnType<typeof setInterval> | null = null;
    let unsubNativeIdle: (() => void) | null = null;

    if (typeof window.electron?.getSystemIdleTime === 'function') {
      if (window.electron.platform === 'darwin') {
        // macOS: API is reliable, no probe needed
        systemIdleApiWorks = true;
      } else if (window.electron.platform === 'win32') {
        // Windows: API usually works, but can be unreliable with games.
        // Enable it initially but rely on runtime validation in markAwayIfEligible.
        systemIdleApiWorks = true;
      } else {
        // Linux: the main process may have a native idle source (Wayland helper
        // or D-Bus) that routes through getSystemIdleTime(). Listen for its
        // signal instead of probing, since the Wayland helper correctly returns
        // 0 when the user is active (which probing misinterprets as "broken").
        if (typeof window.electron?.onNativeIdleSourceReady === 'function') {
          console.log('[IdleDetection] Linux: waiting for main process native idle source');
          unsubNativeIdle = window.electron.onNativeIdleSourceReady(() => {
            if (disposed) return;
            systemIdleApiWorks = true;
            console.log('[IdleDetection] Linux: main process has native idle source — system idle API enabled');
          });
        }

        // Also probe in case the signal was sent before we subscribed (race),
        // or in case there's no native source and the IPC still works (X11).
        console.log('[IdleDetection] Linux: starting system idle API probe (4 attempts over 2 min)');
        probeInterval = setInterval(async () => {
          if (disposed || systemIdleApiWorks) { clearInterval(probeInterval!); probeInterval = null; return; }
          probeCount++;
          try {
            const secs = await window.electron!.getSystemIdleTime();
            console.log(`[IdleDetection] Linux probe #${probeCount}: getSystemIdleTime()=${secs}s`);
            if (secs >= 5) {
              systemIdleApiWorks = true;
              console.log('[IdleDetection] Linux: system idle API works — will use for away detection');
              clearInterval(probeInterval!);
              probeInterval = null;
            }
          } catch (e) {
            console.log(`[IdleDetection] Linux probe #${probeCount} error:`, e);
          }
          if (probeCount >= MAX_PROBES && !systemIdleApiWorks) {
            console.log('[IdleDetection] Linux: system idle API not confirmed after all probes — using renderer web timer only');
            clearInterval(probeInterval!);
            probeInterval = null;
          }
        }, 30_000);
      }
    }

    // Electron: idle detection runs in the main process (immune to renderer
    // throttling from macOS App Nap / screen lock). We just listen for its signal.
    const hasMainProcessIdle = typeof window.electron?.onSystemIdleChanged === 'function';

    let unsubIdle: (() => void) | null = null;
    if (hasMainProcessIdle) {
      console.log('[IdleDetection] Subscribing to main process idle signal');
      unsubIdle = window.electron!.onSystemIdleChanged((isIdle) => {
        if (disposed) return;
        console.log(`[IdleDetection] Main process idle signal: isIdle=${isIdle}`);
        if (isIdle) {
          void markAwayIfEligible();
        } else {
          void restoreIfAutoAway();
        }
      });
    } else {
      console.log('[IdleDetection] No main process idle signal available — using renderer timer only');
    }

    // Reset the idle timer (any activity signal, including weak ones like scroll/focus).
    const resetIdleTimer = () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = setTimeout(() => {
        console.log('[IdleDetection] Web idle timer fired (10 min with no renderer activity)');
        void markAwayIfEligible();
      }, IDLE_TIMEOUT_MS);
    };

    // Strong activity: real user interaction — restores from auto-away,
    // resets idle timer, and sends a heartbeat to the server.
    const handleStrongActivity = () => {
      void restoreIfAutoAway();
      resetIdleTimer();
      sendActivityHeartbeat();
    };

    // Weak activity: can fire without user interaction (programmatic scroll,
    // OS-level focus changes, new messages causing auto-scroll) — only resets
    // the idle timer, never restores from auto-away.
    const handleWeakActivity = () => {
      resetIdleTimer();
    };

    const strongEvents = ['mousemove', 'keydown', 'mousedown', 'touchstart'];
    const weakEvents = ['scroll'];
    strongEvents.forEach(event => window.addEventListener(event, handleStrongActivity, { passive: true }));
    weakEvents.forEach(event => window.addEventListener(event, handleWeakActivity, { passive: true }));
    window.addEventListener('focus', handleWeakActivity);

    // On SignalR reconnect (e.g. after waking from sleep), if the server
    // auto-set us to Away while we were disconnected, adopt that as auto-away
    // so the next activity event restores us to Online.
    const unsubReconnect = onReconnected(() => {
      if (disposed) return;
      const currentStatus = useAuthStore.getState().user?.presenceStatus;
      if (currentStatus === PresenceStatus.Away && !autoAwayRef.current) {
        autoAwayRef.current = true;
      }
    });

    // Always start the web idle timer. On Electron with working powerMonitor
    // (macOS/Windows/X11), markAwayIfEligible checks system idle time and
    // resets the timer if the system is still active. On broken platforms
    // (Wayland) or in the browser, this timer is the primary idle mechanism.
    idleTimerRef.current = setTimeout(() => {
      console.log('[IdleDetection] Web idle timer fired (10 min with no renderer activity)');
      void markAwayIfEligible();
    }, IDLE_TIMEOUT_MS);

    // Send an initial heartbeat so the server knows we're active right now
    sendActivityHeartbeat();

    return () => {
      disposed = true;
      strongEvents.forEach(event => window.removeEventListener(event, handleStrongActivity));
      weakEvents.forEach(event => window.removeEventListener(event, handleWeakActivity));
      window.removeEventListener('focus', handleWeakActivity);

      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (probeInterval) clearInterval(probeInterval);
      unsubNativeIdle?.();
      unsubIdle?.();
      unsubReconnect();
    };
  }, [userId, token, setPresenceStatus]);
}
