// iOS (Capacitor WKWebView or Safari). WebKit's element fullscreen doesn't
// restore the web view's frame on exit — the whole app ends up shifted into the
// safe area (black bands top/bottom) until restart. On iOS, fullscreen video
// must go through the native player (webkitEnterFullscreen) instead.
export const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

interface WebkitHTMLVideoElement extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

/**
 * On iOS, open `video` in the native fullscreen player and return true.
 * Returns false when not on iOS (or unsupported) so the caller can fall back
 * to element fullscreen.
 */
export function enterIOSNativeVideoFullscreen(video: HTMLVideoElement | null | undefined): boolean {
  if (!IS_IOS || !video) return false;
  const v = video as WebkitHTMLVideoElement;
  if (typeof v.webkitEnterFullscreen !== 'function') return false;
  try {
    v.webkitEnterFullscreen();
    return true;
  } catch (err) {
    console.warn('webkitEnterFullscreen failed:', err);
    return false;
  }
}
