import * as Sentry from "@sentry/react";

// In Electron, the app runs at app://abyss/ so the relative tunnel URL
// (/api/sentry-tunnel) would 404. Send directly to Sentry instead —
// there are no ad blockers in Electron to bypass.
const isElectron = !!(window as any).electron;
const tunnel = isElectron ? undefined : "/api/sentry-tunnel";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  enabled: !!import.meta.env.VITE_SENTRY_DSN,
  tunnel,
  integrations: [
    Sentry.browserTracingIntegration(),
    ...(!isElectron ? [Sentry.replayIntegration()] : []),
  ],
  tracesSampleRate: 0.2,
  tracePropagationTargets: [/^\//, /^https?:\/\/[^/]*\/api/],
  replaysSessionSampleRate: isElectron ? 0 : 0.1,
  replaysOnErrorSampleRate: isElectron ? 0 : 1.0,
  environment: isElectron ? "electron" : undefined,
});

// Forward the DSN to the Electron main process so it can init Sentry too.
// The renderer has it baked in by Vite; the main process doesn't.
if (isElectron && import.meta.env.VITE_SENTRY_DSN) {
  (window as any).electron.sendSentryDsn(import.meta.env.VITE_SENTRY_DSN);
}
