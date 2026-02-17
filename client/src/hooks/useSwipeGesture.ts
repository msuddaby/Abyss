import { useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';

const SWIPE_DIRECTION_THRESHOLD = 10; // px to detect scroll direction
const DRAG_ACTIVATION_THRESHOLD = 20; // px to activate drag
const SCROLL_ANGLE_RATIO = 1.5; // vertical/horizontal ratio to prefer scroll

interface SwipeGestureOptions {
  mode: 'edge-open' | 'drawer-close';
  edgeWidth?: number; // Default 50px
  threshold?: number; // Default 80px (open), 100px (close)
  velocityThreshold?: number; // Default 0.3 px/ms
  onDragStart?: () => void;
  onDragMove?: (offset: number) => void;
  onDragEnd?: () => void;
  onSwipeComplete?: () => void;
  enabled?: boolean;
}

export function useSwipeGesture(options: SwipeGestureOptions) {
  const {
    mode,
    edgeWidth = 50,
    threshold = mode === 'edge-open' ? 80 : 100,
    velocityThreshold = 0.3,
    onDragStart,
    onDragMove,
    onDragEnd,
    onSwipeComplete,
    enabled = true,
  } = options;

  const startPosRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const isDraggingRef = useRef(false);
  const directionDetectedRef = useRef(false);

  const triggerHaptic = useCallback(async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
        await Haptics.impact({ style: ImpactStyle.Medium });
      } catch {}
    }
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (!enabled) return;

    const touch = e.touches[0];

    // For edge-open mode, only activate if touch starts within edge width
    if (mode === 'edge-open' && touch.clientX > edgeWidth) {
      return;
    }

    startPosRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
    isDraggingRef.current = false;
    directionDetectedRef.current = false;
  }, [enabled, mode, edgeWidth]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!enabled || !startPosRef.current) return;

    const touch = e.touches[0];
    const deltaX = touch.clientX - startPosRef.current.x;
    const deltaY = touch.clientY - startPosRef.current.y;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    // Detect scroll direction in first few pixels of movement
    if (!directionDetectedRef.current && (absDeltaX > SWIPE_DIRECTION_THRESHOLD || absDeltaY > SWIPE_DIRECTION_THRESHOLD)) {
      directionDetectedRef.current = true;

      // If vertical movement is significantly greater, allow scroll instead
      if (absDeltaY > absDeltaX * SCROLL_ANGLE_RATIO) {
        startPosRef.current = null;
        return;
      }
    }

    // Activate drag after threshold
    if (!isDraggingRef.current && absDeltaX > DRAG_ACTIVATION_THRESHOLD) {
      // For drawer-close mode, only activate on leftward swipe
      if (mode === 'drawer-close' && deltaX > 0) {
        return;
      }
      // For edge-open mode, only activate on rightward swipe
      if (mode === 'edge-open' && deltaX < 0) {
        return;
      }

      isDraggingRef.current = true;
      onDragStart?.();
      triggerHaptic();
    }

    // Update drag position
    if (isDraggingRef.current && onDragMove) {
      if (mode === 'edge-open') {
        // For edge-open: offset goes from 0 to full width
        const offset = Math.max(0, Math.min(312, deltaX));
        onDragMove(offset);
      } else {
        // For drawer-close: offset represents distance dragged left (positive value)
        const offset = Math.max(0, Math.min(312, -deltaX));
        onDragMove(offset);
      }
    }
  }, [enabled, mode, onDragStart, onDragMove, triggerHaptic]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!enabled || !startPosRef.current) return;

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - startPosRef.current.x;
    const deltaTime = Date.now() - startPosRef.current.time;
    const velocity = Math.abs(deltaX) / Math.max(1, deltaTime);
    const distance = Math.abs(deltaX);

    // Determine if gesture should complete
    let shouldComplete = false;

    if (isDraggingRef.current) {
      if (mode === 'edge-open') {
        // Complete if: rightward swipe with sufficient velocity or distance
        shouldComplete = (velocity > velocityThreshold || distance > threshold) && deltaX > 0;
      } else {
        // Complete if: leftward swipe with sufficient velocity or distance
        shouldComplete = (velocity > velocityThreshold || distance > threshold) && deltaX < 0;
      }

      if (shouldComplete) {
        triggerHaptic();
        onSwipeComplete?.();
      } else {
        onDragEnd?.();
      }
    }

    // Reset state
    startPosRef.current = null;
    isDraggingRef.current = false;
    directionDetectedRef.current = false;
  }, [enabled, mode, threshold, velocityThreshold, onDragEnd, onSwipeComplete, triggerHaptic]);

  return { onTouchStart, onTouchMove, onTouchEnd };
}
