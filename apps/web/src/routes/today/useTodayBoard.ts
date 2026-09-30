import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  TodayResponse,
  UpdateJobStatusResult,
  UpdateSubStateResult,
} from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import { getSocket } from '../../lib/api/socket';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';

const POLL_MS = 30_000;

export interface TodayBoardState {
  data: TodayResponse | null;
  /** Set when the LAST load failed. `data` is kept: a dropped poll must not blank the board. */
  error: boolean;
  reload: () => Promise<void>;
  applyMove: (r: UpdateJobStatusResult) => void;
  applySubState: (r: UpdateSubStateResult) => void;
}

/**
 * GET /api/jobs/today, kept fresh.
 *
 * Not useDocument(): that hook blanks `data` on any failed load and has no way
 * to trigger a reload, and this screen needs both — a board that goes empty
 * because one 30-second poll hit a flaky garage Wi-Fi is worse than a board
 * that is a minute old, and every edit must be followed by a reload because
 * the counts, the pulse and the card label are all server-decided.
 *
 * Freshness: a poll, a reload on `job:changed` (emitted by the older job
 * routes; the kanban routes do not emit yet), and a reload when the tab comes
 * back into view. Responses are sequence-numbered so a slow early response can
 * never overwrite a later one.
 */
export function useTodayBoard(): TodayBoardState {
  const [data, setData] = useState<TodayResponse | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api.get<TodayResponse>('/api/jobs/today');
      if (mine !== seq.current) return;
      setData(next);
      setError(false);
    } catch (err) {
      if (isSessionCancelled(err) || mine !== seq.current) return;
      setError(true);
    }
  }, []);

  useEffect(() => {
    // The initial load. `reload` sets state at the far end of a real network
    // await, not synchronously inside this effect body, so this is the
    // ordinary "fetch on mount" shape, not the synchronous-setState-in-effect
    // footgun a lint pass may flag here.
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const onChanged = () => void reload();
    document.addEventListener('visibilitychange', onVisible);
    const socket = getSocket();
    socket.on('job:changed', onChanged);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      socket.off('job:changed', onChanged);
    };
  }, [reload]);

  // The server's answer to a move, applied before the follow-up reload lands —
  // so if that reload fails the card still sits where the SERVER put it, never
  // where the user dropped it. Only the fields the result carries are touched;
  // the label is refreshed by the reload.
  const applyMove = useCallback((r: UpdateJobStatusResult) => {
    setData((d) => {
      if (!d) return d;
      const card = d.jobs.find((j) => j.jobId === r.jobId);
      if (!card) return d;
      const moved = { ...card, status: r.status, subState: r.subState, statusChangedAt: r.statusChangedAt };
      // No column = a terminal, off-board status (DECISION-7-today.md §6:
      // ไม่อนุมัติ / เอารถลง). The job is closed; it leaves the board.
      if (r.column === null) {
        return { ...d, jobs: d.jobs.filter((j) => j.jobId !== r.jobId) };
      }
      const column = r.column;
      return { ...d, jobs: d.jobs.map((j) => (j.jobId === r.jobId ? { ...moved, column } : j)) };
    });
  }, []);

  const applySubState = useCallback((r: UpdateSubStateResult) => {
    setData((d) =>
      d && {
        ...d,
        jobs: d.jobs.map((j) => (j.jobId === r.jobId ? { ...j, subState: r.subState, label: r.label } : j)),
      },
    );
  }, []);

  return { data, error, reload, applyMove, applySubState };
}
