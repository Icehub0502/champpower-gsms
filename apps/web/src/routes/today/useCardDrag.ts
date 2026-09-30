import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { KanbanColumn, TodayJob } from '@gsms/contracts/index.js';

const MOUSE_THRESHOLD_PX = 6;
const TOUCH_HOLD_MS = 350;
const TOUCH_MOVE_CANCEL_PX = 10;

export interface DragState {
  job: TodayJob;
  pointerId: number;
  x: number;
  y: number;
}

export interface UseCardDragResult {
  /** The card currently being dragged, or null. */
  dragging: DragState | null;
  /** The column currently under the dragged card, for a live highlight —
   * purely visual; the actual drop still re-resolves this by rect on pointerup. */
  hoverColumn: KanbanColumn | null;
  /** Attach to each card's onPointerDown. */
  onCardPointerDown: (e: ReactPointerEvent<HTMLElement>, job: TodayJob) => void;
  /**
   * Call once from the click handler that fires right after a drag ends —
   * returns true (and consumes the flag) exactly once, so the synthetic click
   * a pointerup produces does not also open the action sheet.
   */
  consumeDragClick: () => boolean;
  /** Attach to each column body's onPointerEnter / registered rect, so the
   * drag knows which column the finger/cursor is over. */
  registerColumnRef: (column: KanbanColumn) => (el: HTMLElement | null) => void;
}

/**
 * Picking a card up.
 *
 * Two gestures share one code path deliberately (figma-80 brief + the work
 * order): a mouse drag starts after a few pixels of movement (so a click still
 * works), and a touch drag starts after a short hold (so an ordinary vertical
 * swipe still scrolls the column — a kanban that hijacks every touch-move
 * would make the phone tier's "swipe to see the next column" impossible). The
 * calling column decides what to do with `dragging.x/y`; the drop itself is
 * resolved from column rects on pointerup, via `onBoardPointerUp` below.
 */
export function useCardDrag(
  columns: readonly KanbanColumn[],
  onDrop: (job: TodayJob, column: KanbanColumn) => void,
): UseCardDragResult {
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [hoverColumn, setHoverColumn] = useState<KanbanColumn | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const holdTimer = useRef<number | undefined>(undefined);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const justDragged = useRef(false);
  const rects = useRef(new Map<KanbanColumn, HTMLElement>());
  const pointerType = useRef<string>('mouse');

  const registerColumnRef = useCallback(
    (column: KanbanColumn) => (el: HTMLElement | null) => {
      if (el) rects.current.set(column, el);
      else rects.current.delete(column);
    },
    [],
  );

  const columnAt = useCallback(
    (x: number, y: number): KanbanColumn | null => {
      for (const col of columns) {
        const el = rects.current.get(col);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return col;
      }
      return null;
    },
    [columns],
  );

  const beginDrag = useCallback((job: TodayJob, pointerId: number, x: number, y: number) => {
    const state: DragState = { job, pointerId, x, y };
    dragRef.current = state;
    setDragging(state);
  }, []);

  const clearHold = () => {
    if (holdTimer.current !== undefined) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = undefined;
    }
  };

  const onMove = useCallback((e: PointerEvent) => {
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
      const next = { ...dragRef.current, x: e.clientX, y: e.clientY };
      dragRef.current = next;
      setDragging(next);
      setHoverColumn(columnAt(e.clientX, e.clientY));
      e.preventDefault();
      return;
    }
    if (startPos.current && pointerType.current === 'touch') {
      const dx = Math.abs(e.clientX - startPos.current.x);
      const dy = Math.abs(e.clientY - startPos.current.y);
      if (dx > TOUCH_MOVE_CANCEL_PX || dy > TOUCH_MOVE_CANCEL_PX) {
        // Moved before the hold fired — this is a scroll, not a pick-up.
        clearHold();
        cleanupListeners();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnAt]);

  const onUp = useCallback(
    // `cleanupListeners` is deliberately NOT a dependency: it is a plain
    // function redeclared every render that reads window.removeEventListener
    // against the current onMove/onUp/onCancel closures, and `onUp` itself is
    // the exact reference passed to `window.addEventListener('pointerup', ...)`
    // in onCardPointerDown below. If `onUp` changed identity on every render
    // (which depending on cleanupListeners would cause), the removeEventListener
    // in a later cleanup could target a stale reference and leak the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    (e: PointerEvent) => {
      clearHold();
      cleanupListeners();
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(null);
      setHoverColumn(null);
      startPos.current = null;
      if (!d || d.pointerId !== e.pointerId) return;
      justDragged.current = true;
      const col = columnAt(e.clientX, e.clientY);
      if (col !== null) onDrop(d.job, col);
    },
    [columnAt, onDrop],
  );

  function cleanupListeners() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  }

  const onCancel = useCallback((e: PointerEvent) => {
    clearHold();
    cleanupListeners();
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      setDragging(null);
      setHoverColumn(null);
    }
    startPos.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCardPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, job: TodayJob) => {
      if (e.button !== undefined && e.button !== 0) return;
      pointerType.current = e.pointerType;
      startPos.current = { x: e.clientX, y: e.clientY };
      const pointerId = e.pointerId;
      const x = e.clientX;
      const y = e.clientY;

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);

      if (e.pointerType === 'touch') {
        clearHold();
        holdTimer.current = window.setTimeout(() => {
          holdTimer.current = undefined;
          beginDrag(job, pointerId, x, y);
        }, TOUCH_HOLD_MS);
      } else {
        // Mouse/pen: arm on the first move past the threshold.
        const start = { x, y };
        const onFirstMove = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          const dx = Math.abs(ev.clientX - start.x);
          const dy = Math.abs(ev.clientY - start.y);
          if (dx > MOUSE_THRESHOLD_PX || dy > MOUSE_THRESHOLD_PX) {
            window.removeEventListener('pointermove', onFirstMove);
            beginDrag(job, pointerId, ev.clientX, ev.clientY);
          }
        };
        window.addEventListener('pointermove', onFirstMove, { passive: false });
        const removeArmer = () => window.removeEventListener('pointermove', onFirstMove);
        window.addEventListener('pointerup', removeArmer, { once: true });
        window.addEventListener('pointercancel', removeArmer, { once: true });
      }
    },
    [onMove, onUp, onCancel, beginDrag],
  );

  const consumeDragClick = useCallback(() => {
    if (justDragged.current) {
      justDragged.current = false;
      return true;
    }
    return false;
  }, []);

  return { dragging, hoverColumn, onCardPointerDown, consumeDragClick, registerColumnRef };
}
