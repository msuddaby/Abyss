import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Wayland idle detection via ext_idle_notifier_v1 protocol.
 *
 * Spawns a small C helper binary that connects to the compositor and
 * prints IDLE/RESUMED events on stdout. We track timestamps and compute
 * idle duration on demand.
 */

// The helper uses a 10s timeout — the compositor fires IDLE after 10s of
// inactivity, and RESUMED on any input. We add elapsed time since the IDLE
// event to get actual idle duration.
const HELPER_TIMEOUT_MS = 10_000;

let helperProcess: ChildProcess | null = null;
let isIdle = false;
let idledAt = 0; // Date.now() when IDLE was received
let resumedAt = 0; // Date.now() when RESUMED was received (or startup)

function getHelperPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'wayland-idle-helper');
  }
  return path.join(__dirname, '../../resources/bin/wayland-idle-helper');
}

/**
 * Probe whether the Wayland idle helper works on this system.
 * Spawns the helper and waits up to 3s for the READY line.
 * If successful, leaves the helper running for ongoing idle tracking.
 */
export function probeWaylandIdle(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.env.WAYLAND_DISPLAY) {
      console.log('[Idle] Wayland probe: WAYLAND_DISPLAY not set');
      resolve(false);
      return;
    }

    const helperPath = getHelperPath();
    if (!fs.existsSync(helperPath)) {
      console.log(`[Idle] Wayland probe: helper not found at ${helperPath}`);
      resolve(false);
      return;
    }

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.log('[Idle] Wayland probe: timed out after 3s');
        // Kill the probe process since it didn't respond
        proc.kill();
        helperProcess = null;
        resolve(false);
      }
    }, 3000);

    const proc = spawn(helperPath, [String(HELPER_TIMEOUT_MS)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    helperProcess = proc;
    resumedAt = Date.now();

    let buffer = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === 'READY' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          console.log('[Idle] Wayland probe: helper ready (ext_idle_notifier_v1 works)');
          resolve(true);
        } else if (trimmed === 'IDLE') {
          isIdle = true;
          idledAt = Date.now();
          console.log('[Idle] Wayland helper: IDLE');
        } else if (trimmed === 'RESUMED') {
          isIdle = false;
          resumedAt = Date.now();
          console.log('[Idle] Wayland helper: RESUMED');
        }
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.log(`[Idle] Wayland helper stderr: ${msg}`);
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.log(`[Idle] Wayland probe: spawn error: ${err.message}`);
        helperProcess = null;
        resolve(false);
      }
    });

    proc.on('exit', (code) => {
      console.log(`[Idle] Wayland helper exited with code ${code}`);
      helperProcess = null;
      isIdle = false;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(false);
      }
    });
  });
}

/**
 * Get system idle time in seconds based on Wayland helper state.
 *
 * When idle: returns HELPER_TIMEOUT_MS/1000 + seconds since IDLE event
 * When active: returns seconds since RESUMED event (time since last input — always small)
 * Returns null if helper is not running.
 */
export function getWaylandIdleSeconds(): number | null {
  if (!helperProcess) return null;

  if (isIdle) {
    // Helper timeout (10s) + time since the IDLE event was received
    const elapsed = (Date.now() - idledAt) / 1000;
    return Math.floor(HELPER_TIMEOUT_MS / 1000 + elapsed);
  }

  // Active — return 0 (user has been active recently)
  return 0;
}

/**
 * Kill the helper process. Call on app exit.
 */
export function cleanupWaylandIdle(): void {
  if (helperProcess) {
    console.log('[Idle] Killing Wayland idle helper');
    helperProcess.kill();
    helperProcess = null;
  }
}
