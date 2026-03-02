// Pluggable diagnostic reporter — shared code calls reportDiagnostic(),
// and the client wires it up to Sentry (or any other error tracking service).

export type DiagnosticLevel = 'breadcrumb' | 'warning' | 'error';

export interface DiagnosticEvent {
  category: 'signalr' | 'webrtc' | 'livekit';
  message: string;
  level: DiagnosticLevel;
  data?: Record<string, unknown>;
  error?: Error | null;
}

type DiagnosticReporter = (event: DiagnosticEvent) => void;

let reporter: DiagnosticReporter | null = null;

export function setDiagnosticReporter(r: DiagnosticReporter | null): void {
  reporter = r;
}

export function reportDiagnostic(event: DiagnosticEvent): void {
  reporter?.(event);
}
