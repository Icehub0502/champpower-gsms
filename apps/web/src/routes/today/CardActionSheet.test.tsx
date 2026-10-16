// @vitest-environment happy-dom
/**
 * The two moves that close a job and take the card off the board
 * (ไม่อนุมัติ, เอารถลง — DECISION-7-today.md §6) must never be one tap: the
 * sheet asks first, names the car, and sends nothing until confirmed.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayJob } from '@gsms/contracts/index.js';
import { MemoryRouter } from 'react-router-dom';
import { CardActionSheet } from './CardActionSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB: TodayJob = {
  jobId: '00000000-0000-4000-8000-000000000011',
  jobNumber: 'SV-00011',
  queueNo: 3,
  status: 'quoted',
  statusLabel: 'เสนอราคา',
  subState: null,
  label: { text: 'Walk-in', tone: 'orange' },
  jobType: 'normal',
  source: 'walk_in',
  plate: '2กก 5555',
  brand: 'Honda',
  model: 'City',
  color: null,
  customerName: null,
  phone: null,
  bayId: null,
  bayName: null,
  symptom: null,
  bookingSlotStart: null,
  thumbFileId: null,
  createdAt: '2026-09-25T02:00:00.000Z',
  statusChangedAt: '2026-09-25T02:00:00.000Z',
  sla: null,
  column: 2,
  allowedMoves: ['inspecting', 'approved', 'rejected', 'carout'],
};

let container: HTMLDivElement;
let root: Root;
const onMoveStatus = vi.fn();

beforeEach(() => {
  onMoveStatus.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(job: TodayJob) {
  act(() => {
    root.render(
      <CardActionSheet
        job={job}
        busy={false}
        errorText={null}
        onClose={() => {}}
        onMoveStatus={onMoveStatus}
        onSetSubState={() => {}}
      />,
    );
  });
}

/** Exact label first (so 'อนุมัติ' never matches 'ไม่อนุมัติ…'), then a contains-match. */
function button(text: string): HTMLButtonElement {
  const all = [...document.querySelectorAll('button')];
  const b = all.find((el) => el.textContent?.trim() === text) ?? all.find((el) => el.textContent?.includes(text));
  if (!b) throw new Error(`no button containing "${text}"`);
  return b as HTMLButtonElement;
}

describe('CardActionSheet — closing moves', () => {
  it('ไม่อนุมัติ asks first, names the car, and sends nothing until confirmed', () => {
    render(JOB);
    act(() => button('ไม่อนุมัติ').click());
    expect(onMoveStatus).not.toHaveBeenCalled();

    const confirm = document.querySelector('[role="alertdialog"]');
    expect(confirm?.textContent).toContain('Honda City');
    expect(confirm?.textContent).toContain('2กก 5555');
    expect(confirm?.textContent).toContain('SV-00011');
    expect(confirm?.textContent).toContain('ออกจากกระดาน');

    act(() => button('ยืนยันไม่อนุมัติ').click());
    expect(onMoveStatus).toHaveBeenCalledWith('rejected');
  });

  it('เอารถลง also asks, and ย้อนกลับ backs out without sending', () => {
    render(JOB);
    act(() => button('เอารถลง').click());
    act(() => button('ย้อนกลับ').click());
    expect(onMoveStatus).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('เอารถลง says when it is the right button: the customer changed their mind before a quote', () => {
    render(JOB);
    const carout = button('เอารถลง');
    const helper = document.getElementById(carout.getAttribute('aria-describedby')!);
    expect(helper?.textContent).toBe('ลูกค้าเปลี่ยนใจก่อนเสนอราคา');
    // ไม่อนุมัติ is a different button with no such line.
    expect(button('ไม่อนุมัติ').getAttribute('aria-describedby')).toBeNull();
  });

  it('its own confirmation repeats the same words, not the old "before the repair finished"', () => {
    render(JOB);
    act(() => button('เอารถลง').click());
    const confirm = document.querySelector('[role="alertdialog"]')!.textContent!;
    expect(confirm).toContain('ลูกค้าเปลี่ยนใจก่อนเสนอราคา');
    expect(confirm).not.toContain('ก่อนซ่อมเสร็จ');
  });

  it('ส่งแล้ว is marked with an ellipsis (a question follows) and hands the move to the page, which asks', () => {
    render({ ...JOB, status: 'ready', statusLabel: 'พร้อมส่ง', column: 4, allowedMoves: ['delivered'] });
    act(() => button('ส่งแล้ว…').click());
    expect(onMoveStatus).toHaveBeenCalledWith('delivered');
  });

  it('an ordinary move is one tap', () => {
    render(JOB);
    act(() => button('อนุมัติ').click());
    expect(onMoveStatus).toHaveBeenCalledWith('approved');
  });

  it('from กำลังซ่อม, skipping alignment says so in words', () => {
    render({ ...JOB, status: 'repairing', statusLabel: 'กำลังซ่อม', column: 3, allowedMoves: ['approved', 'aligning', 'ready', 'carout'] });
    act(() => button('ไม่ต้องตั้งศูนย์').click());
    expect(onMoveStatus).toHaveBeenCalledWith('ready');
  });

  it('offers only the server-sent allowedMoves — none at all for a role that cannot move jobs', () => {
    render({ ...JOB, allowedMoves: [] });
    expect(document.body.textContent).toContain('ไม่มีสถานะถัดไปให้เลือก');
    expect(document.body.textContent).not.toContain('ไม่อนุมัติ');
  });

  it('never shows an appointment-date field (scheduled is gone, decision 6)', () => {
    render(JOB);
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });
});

describe('CardActionSheet — the way to the quotation (P3.1)', () => {
  it('links to /jobs/:id/quote when the page passes a link', () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <CardActionSheet
            job={JOB}
            busy={false}
            errorText={null}
            quoteHref={`/jobs/${JOB.jobId}/quote`}
            onClose={() => {}}
            onMoveStatus={onMoveStatus}
            onSetSubState={() => {}}
          />
        </MemoryRouter>,
      );
    });
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent?.includes('ใบเสนอราคา'));
    expect(link?.getAttribute('href')).toBe(`/jobs/${JOB.jobId}/quote`);
  });

  it('shows no link at all for a role that sees no prices (no quoteHref)', () => {
    render(JOB);
    expect(document.querySelector('a')).toBeNull();
  });
});
