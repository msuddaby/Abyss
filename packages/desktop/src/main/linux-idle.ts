import { execFile } from 'child_process';

/**
 * Queries system idle time on Linux via D-Bus when Electron's
 * powerMonitor.getSystemIdleTime() is broken (returns 0 on Wayland).
 *
 * Supports:
 *  - KDE / freedesktop ScreenSaver: org.freedesktop.ScreenSaver.GetSessionIdleTime
 *  - GNOME / Mutter: org.gnome.Mutter.IdleMonitor.GetIdletime
 *
 * Returns idle time in seconds, or null if no D-Bus interface is available.
 */

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

// Cache which D-Bus method works (null = not yet probed, false = none work)
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
          resolve(null);
          return;
        }
        // Output format: (uint32 12345,) or (uint64 12345,)
        const match = stdout.match(/\((?:uint\d+ )?(\d+),?\)/);
        if (match) {
          resolve(parseInt(match[1], 10));
        } else {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Probe which D-Bus idle interface is available. Call once at startup.
 * Returns true if a working interface was found.
 */
export async function probeLinuxIdle(): Promise<boolean> {
  for (const method of DBUS_METHODS) {
    const result = await queryDbus(method);
    if (result !== null) {
      cachedMethod = method;
      console.log(`[Idle] Linux D-Bus idle source: ${method.dest}`);
      return true;
    }
  }
  cachedMethod = false;
  console.log('[Idle] No D-Bus idle source found — will use renderer fallback');
  return false;
}

/**
 * Get system idle time in seconds via D-Bus.
 * Returns null if no D-Bus interface is available.
 * Must call probeLinuxIdle() first.
 */
export async function getLinuxIdleSeconds(): Promise<number | null> {
  if (cachedMethod === null || cachedMethod === false) return null;
  const ms = await queryDbus(cachedMethod);
  return ms !== null ? Math.floor(ms / 1000) : null;
}
