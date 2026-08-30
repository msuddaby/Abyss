import { formatFileSize } from './formatting.js';

/**
 * Upload limits as published by GET /api/config, projected from the server's
 * MediaConfig so the two can never drift.
 */
export interface UploadLimits {
  /** Category name ("image", "video", ...) to max size in bytes. Always contains "default". */
  maxSizesByCategory: Record<string, number>;
  /** Lower-case extension (".mp4") to its category. */
  extensionCategories: Record<string, string>;
  /** Custom emoji limit, in bytes. Undefined until /api/config loads. */
  emojiMaxSize?: number;
  /** Soundboard clip and join/leave sound limit, in bytes. */
  soundMaxSize?: number;
  /** Maximum duration for soundboard and join/leave sounds, in seconds. */
  soundMaxDurationSeconds?: number;
  /** Profile avatar limit, in bytes. */
  avatarMaxSize?: number;
  /** Server icon limit, in bytes. */
  serverIconMaxSize?: number;
}

/**
 * Placeholder used before /api/config resolves, or if the fetch fails.
 *
 * Deliberately empty rather than pessimistic: with no limits known, guessing a
 * low cap would reject legitimate large files with a wrong figure ("must be
 * under 10MB" for a video the server would happily take). The server is the
 * authority and now reports size failures cleanly, so when we know nothing we
 * let the upload through and let the server decide.
 */
export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxSizesByCategory: {},
  extensionCategories: {},
};

export type UploadValidationResult = { ok: true } | { ok: false; reason: string };

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase();
}

/**
 * Pre-flight size check mirroring the server's MediaConfig.ValidateExtension +
 * MediaValidator size check, so an oversized file is rejected instantly instead
 * of being discovered by a failed upload.
 *
 * Only enforces size. Type/magic-number validation stays server-side — this is a
 * UX shortcut, not a security boundary.
 */
export function validateFileForUpload(
  file: { name: string; size: number },
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): UploadValidationResult {
  const sizes = limits.maxSizesByCategory ?? {};

  const ext = extensionOf(file.name);
  const category = limits.extensionCategories?.[ext];
  const maxSize = (category ? sizes[category] : undefined) ?? sizes.default;

  // Limits not loaded yet — defer to the server rather than guess.
  if (maxSize == null) return { ok: true };

  if (file.size > maxSize) {
    const label = category ? `${category} files` : 'files';
    return {
      ok: false,
      reason: `${file.name} is ${formatFileSize(file.size)} — ${label} must be under ${formatFileSize(maxSize)}.`,
    };
  }

  return { ok: true };
}

/**
 * Size check against a single published limit (emoji, sound, avatar, server icon).
 *
 * `maxSize` is undefined until /api/config loads; as with validateFileForUpload we
 * stay permissive in that window and let the server decide rather than guess.
 */
export function validateSizedFile(
  file: { size: number },
  maxSize: number | undefined,
  label: string,
): UploadValidationResult {
  if (maxSize == null) return { ok: true };
  if (file.size > maxSize) {
    return {
      ok: false,
      reason: `${label} must be under ${formatFileSize(maxSize)} (this file is ${formatFileSize(file.size)}).`,
    };
  }
  return { ok: true };
}
