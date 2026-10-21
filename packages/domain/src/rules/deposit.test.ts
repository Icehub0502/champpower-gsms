import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_SLIP_TITLE, depositAmountIssue, depositDaysOverdue, depositExpectedDateIssue, depositOffsetPlan,
  isDepositOverdue, roleMayForfeitDeposit, roleMayRefundDeposit,
} from './deposit.js';

describe('deposit rules', () => {
  it('forfeit is manager and above; advisor may refund but not forfeit', () => {
    expect(roleMayForfeitDeposit('owner')).toBe(true);
    expect(roleMayForfeitDeposit('manager')).toBe(true);
    expect(roleMayForfeitDeposit('assistant_manager')).toBe(false);
    expect(roleMayForfeitDeposit('advisor')).toBe(false);
    expect(roleMayRefundDeposit('advisor')).toBe(true);
    expect(roleMayRefundDeposit('technician')).toBe(false);
  });

  it('the slip is never titled a receipt or a tax invoice', () => {
    expect(DEPOSIT_SLIP_TITLE).toBe('ใบรับเงินมัดจำ');
    expect(DEPOSIT_SLIP_TITLE).not.toContain('ใบเสร็จ');
    expect(DEPOSIT_SLIP_TITLE).not.toContain('ใบกำกับ');
  });

  it('overdue starts the day after the expected date, only while held', () => {
    expect(isDepositOverdue('held', '2026-10-20', '2026-10-20')).toBe(false);
    expect(isDepositOverdue('held', '2026-10-20', '2026-10-21')).toBe(true);
    expect(isDepositOverdue('applied', '2026-10-20', '2026-10-30')).toBe(false);
    expect(depositDaysOverdue('held', '2026-10-20', '2026-10-23')).toBe(3);
    expect(depositDaysOverdue('held', '2026-10-20', '2026-10-20')).toBe(0);
  });

  it('amount and expected date gates', () => {
    expect(depositAmountIssue('2000.00')).toBeNull();
    expect(depositAmountIssue('0')).toBe('must_be_positive');
    expect(depositAmountIssue('abc')).toBe('invalid_money');
    expect(depositExpectedDateIssue('2026-10-21', '2026-10-21')).toBeNull();
    expect(depositExpectedDateIssue('2026-10-20', '2026-10-21')).toBe('in_the_past');
    expect(depositExpectedDateIssue('21/10/2026', '2026-10-21')).toBe('invalid_date');
  });

  it('offsets reduce what is owed, never the bill; the 2,000 / 7,500 / 9,500 example', () => {
    const plan = depositOffsetPlan(950000, [{ id: 'a', amount: '2000.00' }]);
    expect(plan).toEqual({ ok: true, offsetTotal: 200000, due: 750000 });
  });

  it('refuses offsets above the bill and duplicates', () => {
    expect(depositOffsetPlan(100000, [{ id: 'a', amount: '1500.00' }])).toEqual({
      ok: false, code: 'deposit_exceeds_bill', over: 50000, max: 100000,
    });
    expect(depositOffsetPlan(100000, [{ id: 'a', amount: '10.00' }, { id: 'a', amount: '10.00' }])).toMatchObject({
      ok: false, code: 'deposit_duplicate',
    });
    expect(depositOffsetPlan(100000, [{ id: 'a', amount: '1000.00' }])).toEqual({ ok: true, offsetTotal: 100000, due: 0 });
  });
});
