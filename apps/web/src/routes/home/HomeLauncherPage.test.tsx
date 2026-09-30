// @vitest-environment happy-dom
/**
 * Every login lands on this launcher, so its staff-app button must go to a
 * screen that exists. /jobs is a "not yet available" placeholder; /today is
 * the live board.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it } from 'vitest';
import { HomeLauncherPage } from './HomeLauncherPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

it('the staff-app button opens /today, not the unported /jobs', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter initialEntries={['/']}><HomeLauncherPage /><Where /></MemoryRouter>);
  });
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'เข้าสู่ระบบงาน')!;
  expect(btn).toBeDefined();
  act(() => btn.click());
  expect(container.querySelector('[data-testid="where"]')?.textContent).toBe('/today');
  act(() => root.unmount());
  container.remove();
});
