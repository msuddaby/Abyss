// Sentry initialization for the Electron main process.
// Must be imported before any other modules in main.ts.
//
// The DSN lives in the root .env as VITE_SENTRY_DSN. In development it's
// available via process.env; in production the renderer (Vite-built) has it
// baked in and sends it to the main process via IPC.  We initialize eagerly
// with whatever we have (dev env var) and lazily re-init when the renderer
// provides the DSN at runtime.

import * as Sentry from '@sentry/electron/main';
import { app, ipcMain } from 'electron';

let initialized = false;

function initSentry(dsn: string): void {
  if (!dsn || initialized) return;
  initialized = true;
  Sentry.init({
    dsn,
    release: `abyss-desktop@${app.getVersion()}`,
    environment: app.isPackaged ? 'production' : 'development',
  });
}

// Try immediate init from env (works in development)
const envDsn = process.env.VITE_SENTRY_DSN || '';
if (envDsn) initSentry(envDsn);

// The renderer sends the DSN once Sentry is initialized in the browser.
// This covers production builds where process.env is empty.
ipcMain.on('sentry-dsn', (_event, dsn: string) => {
  initSentry(dsn);
});

export { Sentry };
