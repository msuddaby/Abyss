import { execFile } from 'child_process';
import { probeWaylandIdle, getWaylandIdleSeconds } from './wayland-idle';

/**
 * Linux idle detection with priority chain:
 *   1. Wayland ext_idle_notifier_v1 (via helper binary)
 *   2. D-Bus (KDE/GNOME)
 *   3. Renderer timer fallback (no action needed here)
 */

export type LinuxIdleSource = 'wayland' | 'dbus' | null;

let activeSource: LinuxIdleSource = null;

// ── D-Bus fallback ──────────────────────────────────────────────────

type DbusMethod = {
  dest: string;
  objectPath: string;
  method: string;
};

const DBUS_METHODS: DbusMethod[] = [
  // KDE Plasma (implements freedesktop ScreenSaver interface)
  {
    dest: 'org.freedesktop.ScreenSaver',
    objectPath: '/org/freedesktop/ScreenSaver',
    method: 'org.freedesktop.ScreenSaver.GetSessionIdleTime',
  },
  // GNOME (Mutter idle monitor)
  {
    dest: 'org.gnome.Mutter.IdleMonitor',
    objectPath: '/org/gnome/Mutter/IdleMonitor/Core',
    method: 'org.gnome.Mutter.IdleMonitor.GetIdletime',
  },
];

let cachedMethod: DbusMethod | null | false = null;

function queryDbus(method: DbusMethod): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'gdbus',
      [
        'call', '--session',
        '--dest', method.dest,
        '--object-path', method.objectPath,
        '--method', method.method,
      ],
      { timeout: 2000 },
      (error, stdout) => {
        if (error) {
          console.log(`[Idle] D-Bus query failed for ${method.method}: ${error.message}`);
          resolve(null);
          return;
        }
        // Output format: (uint32 12345,) or (uint64 12345,)
        const match = stdout.match(/\((?:uint\d+ )?(\d+),?\)/);
        if (match) {
          const ms = parseInt(match[1], 10);
          console.log(`[Idle] D-Bus ${method.method} returned ${ms}ms (${Math.floor(ms / 1000)}s)`);
          resolve(ms);
        } else {
          console.log(`[Idle] D-Bus ${method.method} unparseable output: ${stdout.trim()}`);
          resolve(null);
        }
      },
    );
  });
}

async function probeDbusIdle(): Promise<boolean> {
  for (const method of DBUS_METHODS) {
    const result = await queryDbus(method);
    if (result !== null) {
      cachedMethod = method;
      return true;
    }
  }
  cachedMethod = false;
  return false;
}

async function getDbusIdleSeconds(): Promise<number | null> {
  if (cachedMethod === null || cachedMethod === false) return null;
  const ms = await queryDbus(cachedMethod);
  return ms !== null ? Math.floor(ms / 1000) : null;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Probe for the best available idle source on Linux.
 * Priority: Wayland helper → D-Bus → none (renderer fallback).
 * Returns true if any source was found.
 */
export async function probeLinuxIdle(): Promise<boolean> {
  // Try Wayland ext_idle_notifier_v1 first
  const waylandWorks = await probeWaylandIdle();
  if (waylandWorks) {
    activeSource = 'wayland';
    console.log('[Idle] Linux idle source: wayland (ext_idle_notifier_v1)');
    return true;
  }

  // Fall back to D-Bus
  const dbusWorks = await probeDbusIdle();
  if (dbusWorks) {
    activeSource = 'dbus';
    console.log(`[Idle] Linux idle source: dbus (${cachedMethod && (cachedMethod as DbusMethod).dest})`);
    return true;
  }

  activeSource = null;
  console.log('[Idle] No Linux idle source found — will use renderer fallback');
  return false;
}

/**
 * Get system idle time in seconds using the probed source.
 * Returns null if no source is available.
 */
export async function getLinuxIdleSeconds(): Promise<number | null> {
  if (activeSource === 'wayland') {
    return getWaylandIdleSeconds();
  }
  if (activeSource === 'dbus') {
    return getDbusIdleSeconds();
  }
  return null;
}
