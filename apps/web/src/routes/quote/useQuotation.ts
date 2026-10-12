import { useCallback, useEffect, useRef, useState } from 'react';
import type { Quotation } from '@gsms/contracts/index.js';
import { ApiError, api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { describeQuoteError, type QuoteFailure } from './quoteErrors';

export type QuotationLoad =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error' }
  | { phase: 'ready'; quotation: Quotation };

// Both arms carry both fields: apps/web compiles without strictNullChecks, where
// `!result.ok` does not narrow a union, so `failure` must exist on either arm.
export type RunResult<T> = { ok: true; value: T; failure: null } | { ok: false; value: null; failure: QuoteFailure };

export interface QuotationState {
  load: QuotationLoad;
  /** Key of the mutation in flight, or null. While set, EVERY mutation button is disabled. */
  busy: string | null;
  reload: () => Promise<void>;
  /**
   * Runs one mutation that answers with the quotation (every quotation door
   * does), puts the server's answer on screen, and refuses to start a second
   * one while the first is on the wire — a double tap must not decide a line
   * twice or issue twice. A stale refusal reloads the quotation.
   */
  run: <T extends Quotation>(key: string, call: () => Promise<T>) => Promise<RunResult<T>>;
  /** The same in-flight guard for a request that does not return the quotation (catalog price, model). */
  guard: <T>(key: string, call: () => Promise<T>) => Promise<RunResult<T>>;
}

export function quotationPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/quotation`;
}

/**
 * GET /api/jobs/:jobId/quotation, plus every mutation on it.
 *
 * Not useDocument(): that hook turns any failure into `data: null`, so "this
 * job has no quotation yet" (404 quotation_not_found — show "สร้างใบเสนอราคา")
 * and "the request failed" (show "ลองใหม่") would look the same, and it has
 * no way to take the server's answer to a mutation. Same reasoning as
 * routes/today/useTodayBoard.ts. All HTTP still goes through lib/api/client.
 */
export function useQuotation(jobId: string): QuotationState {
  const [load, setLoad] = useState<QuotationLoad>({ phase: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  // A ref as well as state: two taps inside one render must still see "busy".
  const busyRef = useRef<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const q = await api.get<Quotation>(quotationPath(jobId));
      if (mine === seq.current) setLoad({ phase: 'ready', quotation: q });
    } catch (err) {
      if (isSessionCancelled(err) || mine !== seq.current) return;
      if (err instanceof ApiError && err.status === 404 && err.message === 'quotation_not_found') {
        setLoad({ phase: 'missing' });
        return;
      }
      // Keep a quotation already on screen: a dropped reload must not blank the page.
      setLoad((prev) => (prev.phase === 'ready' ? prev : { phase: 'error' }));
    }
  }, [jobId]);

  useEffect(() => {
    // Fetch on mount. `reload` sets state only after a real network await, not
    // synchronously in this effect (same shape as useTodayBoard's initial load).
    void reload();
  }, [reload]);

  const guard = useCallback(async <T,>(key: string, call: () => Promise<T>): Promise<RunResult<T>> => {
    if (busyRef.current !== null) {
      return { ok: false, value: null, failure: { ...describeQuoteError(null), text: '', cancelled: true } };
    }
    busyRef.current = key;
    setBusy(key);
    try {
      return { ok: true, value: await call(), failure: null };
    } catch (err) {
      const failure = describeQuoteError(err);
      if (failure.stale) void reload();
      return { ok: false, value: null, failure };
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, [reload]);

  const run = useCallback(async <T extends Quotation>(key: string, call: () => Promise<T>): Promise<RunResult<T>> => {
    const result = await guard(key, call);
    if (result.ok) {
      // Invalidate any reload still on the wire: it was asked before this answer.
      seq.current += 1;
      setLoad({ phase: 'ready', quotation: result.value });
    }
    return result;
  }, [guard]);

  return { load, busy, reload, run, guard };
}
