// @vitest-environment happy-dom
/**
 * useDocument: the first load behaves as before (a failure means no data),
 * a failed RE-load keeps the data already on screen and says so, and only the
 * newest response is ever applied.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGet = vi.fn();
vi.mock('../lib/api/client', () => ({ api: { get: (...a: unknown[]) => apiGet(...a) } }));
vi.mock('../lib/api/socket', () => ({ getSocket: () => ({ on: vi.fn(), off: vi.fn() }) }));

import { useDocument, type DocumentState } from './useDocument';

let latest: DocumentState<{ v: number }>;
function Probe() {
  latest = useDocument<{ v: number }>('/api/thing');
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  apiGet.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useDocument', () => {
  it('first load failing: no data, as before', async () => {
    apiGet.mockRejectedValueOnce(new Error('down'));
    act(() => root.render(<Probe />));
    await settle();
    expect(latest.data).toBeNull();
    expect(latest.loading).toBe(false);
  });

  it('a failed reload keeps the data on screen and raises `error`; a good one clears it', async () => {
    apiGet.mockResolvedValueOnce({ v: 1 });
    act(() => root.render(<Probe />));
    await settle();

    apiGet.mockRejectedValueOnce(new Error('down'));
    act(() => latest.reload?.());
    await settle();
    expect(latest.data).toEqual({ v: 1 });
    expect(latest.error).toBe(true);

    apiGet.mockResolvedValueOnce({ v: 2 });
    act(() => latest.reload?.());
    await settle();
    expect(latest.data).toEqual({ v: 2 });
    expect(latest.error).toBe(false);
  });

  it('an older, slower response never overwrites a newer one', async () => {
    apiGet.mockResolvedValueOnce({ v: 1 });
    act(() => root.render(<Probe />));
    await settle();

    const slow = deferred<{ v: number }>();
    const fast = deferred<{ v: number }>();
    apiGet.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    act(() => latest.reload?.()); // asked first
    act(() => latest.reload?.()); // asked second
    fast.resolve({ v: 3 });
    await settle();
    slow.resolve({ v: 2 }); // arrives last, but answers the older question
    await settle();
    expect(latest.data).toEqual({ v: 3 });
  });
});
