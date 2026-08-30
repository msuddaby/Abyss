import { UPLOAD_STALLED } from "@abyss/shared";

interface UploadError {
  code?: string;
  name?: string;
  response?: { status?: number; data?: unknown };
}

export function asUploadError(err: unknown): UploadError {
  return (err && typeof err === 'object' ? err : {}) as UploadError;
}

/** True when the failure was a deliberate cancel, which shouldn't be reported as an error. */
export function isCanceledUpload(err: unknown): boolean {
  const e = asUploadError(err);
  return e.name === 'CanceledError' || e.code === 'ERR_CANCELED';
}

/**
 * Pull a readable message out of a 400 body. Upload endpoints return a plain
 * string from MediaValidator, but ASP.NET's model binder returns a ProblemDetails
 * object — notably when the multipart body exceeds Kestrel's limit, which it
 * reports as a validation error rather than a 413.
 */
function extractProblemMessage(data: unknown): string | null {
  if (typeof data === 'string') return data.trim() || null;
  if (!data || typeof data !== 'object') return null;
  const problem = data as { title?: unknown; errors?: Record<string, unknown> };
  const firstError = Object.values(problem.errors ?? {})
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (firstError) {
    // Kestrel's wording leaks the byte count; say something the user can act on.
    if (/request body too large/i.test(firstError)) {
      return 'That file is too large to upload.';
    }
    return firstError;
  }
  return typeof problem.title === 'string' && problem.title.trim() ? problem.title : null;
}

/** Turn an upload failure into something a user can act on. */
export function describeUploadError(err: unknown): string {
  const e = asUploadError(err);
  if (e.code === UPLOAD_STALLED) {
    return 'Upload stalled — the file may be too large or the connection dropped.';
  }
  const status = e.response?.status;
  if (status === 413) return 'That file is too large to upload.';
  if (status === 429 || status === 503) {
    return "You're uploading too quickly. Please wait a moment and try again.";
  }
  if (status === 400) {
    return extractProblemMessage(e.response?.data) ?? 'That file could not be uploaded.';
  }
  if (status === 403) return 'You do not have permission to upload here.';
  return 'Upload failed — check your connection and try again.';
}
