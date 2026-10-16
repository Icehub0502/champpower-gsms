// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom(): never {
  throw new Error('render failed');
}

describe('ErrorBoundary', () => {
  it('a render error shows the Thai panel, not a white page', () => {
    // React reports the caught error on console.error; keep the test output clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<ErrorBoundary><Boom /></ErrorBoundary>));
    expect(container.textContent).toContain('เกิดข้อผิดพลาด โหลดหน้าใหม่');
    expect(container.querySelector('[role="alert"] button')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
    spy.mockRestore();
  });
});
