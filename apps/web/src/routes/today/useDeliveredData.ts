import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeliveredJobsPage, JobDetail } from '@gsms/contracts/index.js';
import { ApiError, api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';

// Both reads are on-demand and short-lived (a panel opened by hand), so they
// use plain state rather than useCollection/useDocument: those hooks blank
// their data on any failed reload and cannot tell "not found" from "failed",
// and this screen needs both (the undo must not lose the job it is showing
// because one refetch hit flaky garage Wi-Fi).

export type Loaded<T> =
  | { kind: 'loading' }
  | { kind: 'error'; notFound: boolean }
  | { kind: 'ok'; data: T };

export const DELIVERED_PAGE_SIZE = 10;

/** GET /api/jobs?status=delivered&date=today — the one list the undo needs. */
export function useDeliveredJobs(page: number) {
  const [state, setState] = useState<Loaded<DeliveredJobsPage>>({ kind: 'loading' });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const data = await api.get<DeliveredJobsPage>(
        `/api/jobs?status=delivered&date=today&page=${page}&pageSize=${DELIVERED_PAGE_SIZE}`,
      );
      if (mine === seq.current) setState({ kind: 'ok', data });
    } catch (err) {
      if (isSessionCancelled(err) || mine !== seq.current) return;
      setState({ kind: 'error', notFound: false });
    }
  }, [page]);

  useEffect(() => {
    setState({ kind: 'loading' });
    void load();
    // A slower response for an older page must never overwrite a newer one.
    return () => {
      seq.current++;
    };
  }, [load]);

  return { state, reload: load };
}

/** GET /api/jobs/:id — summary, history, and this caller's allowedMoves. */
export function useJobDetail(jobId: string) {
  const [state, setState] = useState<Loaded<JobDetail>>({ kind: 'loading' });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const data = await api.get<JobDetail>(`/api/jobs/${jobId}`);
      if (mine === seq.current) setState({ kind: 'ok', data });
    } catch (err) {
      if (isSessionCancelled(err) || mine !== seq.current) return;
      // A refetch that fails after the job was already shown keeps showing it.
      setState((prev) =>
        prev.kind === 'ok' ? prev : { kind: 'error', notFound: err instanceof ApiError && err.status === 404 },
      );
    }
  }, [jobId]);

  useEffect(() => {
    setState({ kind: 'loading' });
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  return { state, reload: load };
}
