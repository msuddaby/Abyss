import { useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';

const LONG_PRESS_DELAY = 400;
const MOVE_THRESHOLD = 10;

export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const elRef = useRef<HTMLElement | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    elRef.current?.classList.remove('long-press-active');
    posRef.current = null;
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    posRef.current = { x: touch.clientX, y: touch.clientY };
    firedRef.current = false;
    elRef.current = e.currentTarget as HTMLElement;
    elRef.current.classList.add('long-press-active');

    timerRef.current = setTimeout(async () => {
      firedRef.current = true;
      elRef.current?.classList.remove('long-press-active');

      // Block synthetic mouse events (mousedown/mouseup/click) that the browser
      // generates after touchend — these would close the context menu immediately.
      // Capture phase + once ensures we only eat the very next event of each type.
      const block = (evt: Event) => {
        evt.stopPropagation();
        evt.preventDefault();
      };
      for (const type of ['mousedown', 'mouseup', 'click'] as const) {
        document.addEventListener(type, block, { capture: true, once: true });
      }
      // Safety cleanup in case the events never fire
      setTimeout(() => {
        for (const type of ['mousedown', 'mouseup', 'click'] as const) {
          document.removeEventListener(type, block, { capture: true });
        }
      }, 600);

      if (Capacitor.isNativePlatform()) {
        try {
          const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
          Haptics.impact({ style: ImpactStyle.Medium });
        } catch {}
      }

      onLongPress(posRef.current!.x, posRef.current!.y);
    }, LONG_PRESS_DELAY);
  }, [onLongPress]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!posRef.current) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - posRef.current.x);
    const dy = Math.abs(touch.clientY - posRef.current.y);
    if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
      cancel();
    }
  }, [cancel]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (firedRef.current) {
      e.preventDefault();
    }
    cancel();
  }, [cancel]);

  return { onTouchStart, onTouchMove, onTouchEnd };
}
