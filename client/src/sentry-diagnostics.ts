// Wires the shared diagnostic reporter to Sentry for error tracking.
// Imported early in main.tsx (after instrument.ts initializes Sentry).

import * as Sentry from '@sentry/react';
import { setDiagnosticReporter, type DiagnosticEvent } from '@abyss/shared';

// Rate-limit Sentry events to avoid flooding during flaky connections.
// Breadcrumbs are unlimited (they're cheap and provide context for real errors).
const RATE_LIMIT_MS = 30_000;
const lastEventTime = new Map<string, number>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const last = lastEventTime.get(key);
  if (last && now - last < RATE_LIMIT_MS) return true;
  lastEventTime.set(key, now);
  return false;
}

setDiagnosticReporter((event: DiagnosticEvent) => {
  // Always add as a breadcrumb — these show up as context when a real error fires
  Sentry.addBreadcrumb({
    category: event.category,
    message: event.message,
    level: event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : 'info',
    data: event.data ?? undefined,
  });

  // For warning/error level, also create a Sentry event (rate-limited)
  if (event.level === 'warning' || event.level === 'error') {
    const rateKey = `${event.category}:${event.message.slice(0, 80)}`;
    if (isRateLimited(rateKey)) return;

    const sentryLevel = event.level === 'error' ? 'error' : 'warning';
    const contexts = event.data ? { diagnostics: event.data } : undefined;

    if (event.error) {
      Sentry.captureException(event.error, {
        level: sentryLevel,
        tags: { 'diagnostic.category': event.category },
        contexts,
      });
    } else {
      Sentry.captureMessage(event.message, {
        level: sentryLevel,
        tags: { 'diagnostic.category': event.category },
        contexts,
      });
    }
  }
});
