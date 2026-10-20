import { useCallback, useEffect, useRef, useState } from 'react';
import type { Receipt } from '@gsms/contracts/index.js';
import { ApiError, api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { describeBillError, type BillFailure } from './billErrors';

export type ReceiptLoad =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error' }
  | { phase: 'ready'; receipt: Receipt };

// Both arms carry both fields (apps/web compiles without strictNullChecks).
export type BillRunResult<T> = { ok: true; value: T; failure: null } | { ok: false; value: null; failure: BillFailure };

export function receiptPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/receipt`;
}

export interface ReceiptState {
  load: ReceiptLoad;
  /** Key of the mutation in flight, or null. While set, EVERY mutation button is disabled. */
  busy: string | null;
  reload: () => Promise<void>;
  /** One mutation that answers with something; a second one cannot start while it is on the wire. */
  guard: <T>(key: string, call: () => Promise<T>) => Promise<BillRunResult<T>>;
  /** Same, for a door that answers with the receipt: the answer goes on screen. */
  run: (key: string, call: () => Promise<Receipt>) => Promise<BillRunResult<Receipt>>;
  /** Put a receipt the server returned inside another shape (close) on screen. */
  show: (receipt: Receipt) => void;
}

/**
 * GET /api/jobs/:jobId/receipt plus every mutation on it. Not useDocument()
 * for the same reason as useQuotation: "no draft yet" (404 receipt_not_found,
 * show "เริ่มทำบิล") and "the request failed" (show "ลองใหม่") must not look
 * the same, and mutations answer with the receipt.
 */
export function useReceipt(jobId: string): ReceiptState {
  const [load, setLoad] = useState<ReceiptLoad>({ phase: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api.get<Receipt>(receiptPath(jobId));
      if (mine === seq.current) setLoad({ phase: 'ready', receipt: r });
    } catch (err) {
      if (isSessionCancelled(err) || mine !== seq.current) return;
      if (err instanceof ApiError && err.status === 404 && err.message === 'receipt_not_found') {
        setLoad({ phase: 'missing' });
        return;
      }
      setLoad((prev) => (prev.phase === 'ready' ? prev : { phase: 'error' }));
    }
  }, [jobId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const show = useCallback((receipt: Receipt) => {
    seq.current += 1;
    setLoad({ phase: 'ready', receipt });
  }, []);

  const guard = useCallback(async <T,>(key: string, call: () => Promise<T>): Promise<BillRunResult<T>> => {
    if (busyRef.current !== null) {
      return { ok: false, value: null, failure: { ...describeBillError(null), text: '', cancelled: true } };
    }
    busyRef.current = key;
    setBusy(key);
    try {
      return { ok: true, value: await call(), failure: null };
    } catch (err) {
      const failure = describeBillError(err);
      if (failure.stale) void reload();
      return { ok: false, value: null, failure };
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, [reload]);

  const run = useCallback(async (key: string, call: () => Promise<Receipt>) => {
    const result = await guard(key, call);
    if (result.ok) show(result.value);
    return result;
  }, [guard, show]);

  return { load, busy, reload, guard, run, show };
}
