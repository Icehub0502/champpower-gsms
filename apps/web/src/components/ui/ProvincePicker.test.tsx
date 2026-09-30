// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THAI_PROVINCES } from '@champpower/domain';
import { ProvincePicker, filterProvinces } from './ProvincePicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const emitted = vi.fn();

function Harness({ initial = '' }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return <ProvincePicker value={v} onChange={(p) => { emitted(p); setV(p); }} />;
}

beforeEach(() => {
  emitted.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const input = () => container.querySelector('input')!;
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = (k: string) => act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const options = () => Array.from(container.querySelectorAll('[role="option"]')).map((o) => o.textContent?.replace('✓ ', ''));

describe('filterProvinces', () => {
  it('returns all 77 provinces plus เบตง for empty text, Bangkok first', () => {
    expect(filterProvinces('')).toHaveLength(78);
    expect(filterProvinces('')[0]).toBe('กรุงเทพมหานคร');
  });
  it('filters by Thai substring, prefix matches first, and understands กทม', () => {
    expect(filterProvinces('สมุทร')).toEqual(['สมุทรปราการ', 'สมุทรสงคราม', 'สมุทรสาคร']);
    expect(filterProvinces('กทม')[0]).toBe('กรุงเทพมหานคร');
    expect(filterProvinces('ซซซ')).toEqual([]);
  });
});

describe('เบตง', () => {
  it('is found by Thai or Latin spelling, in its own labelled group, and emits เบตง', () => {
    expect(filterProvinces('betong')).toEqual(['เบตง']);
    type('เบตง');
    expect(container.textContent).toContain('ป้ายพิเศษ (ไม่ใช่จังหวัด)');
    expect(container.textContent).toContain('ป้ายเบตง (ยะลา)');
    expect(emitted).toHaveBeenLastCalledWith('เบตง');
    type('');
    type('Betong');
    act(() => { container.querySelector('[role="option"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); });
    expect(emitted).toHaveBeenLastCalledWith('เบตง');
    expect(input().value).toBe('เบตง');
  });
});

describe('ProvincePicker', () => {
  it('has no default: empty value, list closed', () => {
    expect(input().value).toBe('');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('filters while typing, and emits only when the text is an exact official name', () => {
    type('สมุทร');
    expect(options()).toEqual(['สมุทรปราการ', 'สมุทรสงคราม', 'สมุทรสาคร']);
    expect(emitted).not.toHaveBeenCalled();
    type('สมุทรปราการ');
    expect(emitted).toHaveBeenLastCalledWith('สมุทรปราการ');
    type('สมุทรปราการx');
    expect(emitted).toHaveBeenLastCalledWith('');
    for (const [p] of emitted.mock.calls) expect(p === '' || (THAI_PROVINCES as readonly string[]).includes(p)).toBe(true);
  });

  it('picks with the keyboard and Enter does not submit the surrounding form', () => {
    type('เชียง');
    key('ArrowDown');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => { input().dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true);
    expect(emitted).toHaveBeenLastCalledWith('เชียงใหม่');
    expect(input().value).toBe('เชียงใหม่');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('picks by touch/pointer on an option', () => {
    type('ภูเ');
    const opt = container.querySelector('[role="option"]')!;
    act(() => { opt.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); });
    expect(emitted).toHaveBeenLastCalledWith('ภูเก็ต');
  });

  it('shows a warning word (not colour) for unresolved text once closed', () => {
    type('เชียง');
    key('Escape');
    expect(container.textContent).toContain('⚠ ยังไม่ได้เลือก');
  });

  it('copies an outside change into the box', () => {
    act(() => root.render(<ProvincePicker value="ระยอง" onChange={emitted} />));
    expect(input().value).toBe('ระยอง');
  });
});
