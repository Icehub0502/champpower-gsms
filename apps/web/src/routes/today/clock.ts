import { useSyncExternalStore } from 'react';

// One interval for the whole board, however many cards are ticking. Every
// reader subscribes to the same clock, so the countdowns and the page's
// "เกิน SLA" filter can never disagree about what time it is.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: number | undefined;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Ticks every second. For the card countdowns only — a component using this
 * re-renders once a second, so keep it at the leaves. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}

/**
 * The same clock, snapped to the minute. useSyncExternalStore re-renders only
 * when the snapshot changes, so a component reading this re-renders once a
 * minute — used by TodayPage, where a per-second tick would re-render every
 * column and card on the board for a filter that only needs minutes.
 */
export function useMinute(): number {
  return useSyncExternalStore(subscribe, () => Math.floor(now / 60_000) * 60_000);
}
