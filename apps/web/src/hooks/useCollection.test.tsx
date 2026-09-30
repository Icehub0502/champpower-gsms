// @vitest-environment happy-dom
/**
 * "The request failed" must never look like "there is nothing". Before this
 * field existed, a 404 from an unmounted endpoint came back as `rows: []`,
 * and /jobs showed an empty list while the workshop was full of cars.
 */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionState } from './useCollection';

const apiGet = vi.fn();
vi.mock('../lib/api/client', () => ({ api: { get: (...a: unknown[]) => apiGet(...a) } }));
const handlers = new Map<string, (p: unknown) => void>();
vi.mock('../lib/api/socket', () => ({
  getSocket: () => ({
    on: (e: string, h: (p: unknown) => void) => handlers.set(e, h),
    off: (e: string) => handlers.delete(e),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row { id: string }
let latest: CollectionState<Row>;
let container: HTMLDivElement;
let root: Root;

async function mount() {
  const { useCollection } = await import('./useCollection');
  function Probe() {
    const state = useCollection<Row>('/api/widgets');
    // Recorded in an effect, not during render — reassigning an outside
    // variable while rendering is itself the kind of bug this hook's fix is
    // about (a side effect masquerading as a pure read).
    useEffect(() => {
      latest = state;
    });
    return null;
  }
  await act(async () => {
    root.render(<Probe />);
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  apiGet.mockReset();
  handlers.clear();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('useCollection', () => {
  it('a successful empty response is "nothing", with no error', async () => {
    apiGet.mockResolvedValue([]);
    await mount();
    expect(latest).toMatchObject({ loading: false, rows: [], error: null });
  });

  it('a failed request sets `error` — it is not reported as an empty list', async () => {
    apiGet.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    await mount();
    expect(latest.loading).toBe(false);
    expect(latest.rows).toEqual([]);
    expect(latest.error).toBeInstanceOf(Error);
    expect(latest.error?.message).toBe('Not Found');
  });

  it('a failed REFETCH keeps the rows already shown and flags the error; a later success clears it', async () => {
    apiGet.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    await mount();
    expect(latest.rows).toHaveLength(2);

    apiGet.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      handlers.get('widget:changed')!(undefined); // unrecognised payload -> refetch
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(latest.rows).toHaveLength(2);
    expect(latest.error?.message).toBe('network down');

    apiGet.mockResolvedValueOnce([{ id: 'a' }]);
    await act(async () => {
      handlers.get('widget:changed')!(undefined);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(latest).toMatchObject({ rows: [{ id: 'a' }], error: null });
  });
});
