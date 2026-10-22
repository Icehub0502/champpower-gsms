import { useCallback, useRef, useState } from 'react';
import { describeStockError, type StockFailure } from './stockErrors';
import { newRequestId } from './stockLabels';

export type MutationResult<T> = { ok: true; value: T } | { ok: false; failure: StockFailure };

export interface StockMutation {
  busy: boolean;
  failure: StockFailure | null;
  /** The requestId the next attempt will carry. */
  requestId: () => string;
  /**
   * Runs one write. `call` gets the current requestId. Guarded by a ref AND state, so a
   * double tap between renders is still one request.
   *
   * requestId lifetime (WO-006 backend facts): it stays the same across every retry of
   * the same attempt — a timeout, a 5xx, a dropped Wi-Fi, a 409 the person then fixes — so
   * a request that DID land is answered with `replayed:true` instead of a second move. It
   * is replaced only after the server has answered with success: the next press is a new fact.
   */
  run: <T>(call: (requestId: string) => Promise<T>) => Promise<MutationResult<T> | null>;
  /** Start a brand-new attempt (a dialog re-opened for another SKU). */
  reset: () => void;
  clearFailure: () => void;
}

export function useStockMutation(): StockMutation {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const idRef = useRef<string>(newRequestId());
  const [failure, setFailure] = useState<StockFailure | null>(null);

  const run = useCallback(async <T,>(call: (requestId: string) => Promise<T>): Promise<MutationResult<T> | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const value = await call(idRef.current);
      idRef.current = newRequestId();
      return { ok: true, value };
    } catch (err) {
      const f = describeStockError(err);
      if (!f.cancelled) setFailure(f);
      return { ok: false, failure: f };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const reset = useCallback(() => {
    idRef.current = newRequestId();
    setFailure(null);
  }, []);
  const clearFailure = useCallback(() => setFailure(null), []);
  const requestId = useCallback(() => idRef.current, []);

  return { busy, failure, requestId, run, reset, clearFailure };
}
