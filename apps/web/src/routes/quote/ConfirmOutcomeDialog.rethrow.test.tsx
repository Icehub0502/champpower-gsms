// @vitest-environment happy-dom
/**
 * The preview in "ยืนยันผลลูกค้า" swallows ONLY the domain's MoneyError (a sum
 * numeric(12,2) cannot hold). Any other error is a bug and must reach the
 * ErrorBoundary instead of being shown as "ยอดเกินที่ระบบรองรับ".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@champpower/domain', async (importOriginal) => {
  const real = await importOriginal<typeof import('@champpower/domain')>();
  return {
    ...real,
    quoteTotals: () => {
      throw new TypeError('a bug, not an overflow');
    },
  };
});

import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import { ConfirmOutcomeDialog } from './ConfirmOutcomeDialog';
import { cutSetQuotation } from './quoteFixtures';
import { field, mount, type, type Mounted } from './quoteTestDom';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe('ConfirmOutcomeDialog preview', () => {
  it('a non-MoneyError is rethrown to the ErrorBoundary, not reported as an overflow', () => {
    // React 19 reports a caught render error on console.error; keep the output clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { q, head } = cutSetQuotation();
    m = mount(
      <ErrorBoundary>
        <ConfirmOutcomeDialog quotation={q} busy={false} onSubmit={vi.fn()} onClose={() => {}} />
      </ErrorBoundary>,
    );
    const set = document.querySelector(`[data-set-id="${head.id}"]`) as HTMLElement;
    type(field('ยอดใหม่ของชุด', set), '18000');
    expect(document.body.textContent).toContain('เกิดข้อผิดพลาด โหลดหน้าใหม่');
    expect(document.body.textContent).not.toContain('ยอดเกินที่ระบบรองรับ');
    spy.mockRestore();
  });
});
