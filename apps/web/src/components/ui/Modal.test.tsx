// @vitest-environment happy-dom
/**
 * The shared dialog. Rendered into document.body so no ancestor's stacking
 * context (the sticky top bar's z-index, a sticky column) can put it under the
 * phone dock; an optional footer stays outside the scrolling body.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';
import { mount, type Mounted } from '../../routes/quote/quoteTestDom';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe('Modal', () => {
  it('renders into document.body, outside the tree it was opened from', () => {
    m = mount(<div className="topbar"><Modal title="t" onClose={() => {}}>body</Modal></div>);
    const backdrop = document.querySelector('.modal-backdrop')!;
    expect(backdrop).not.toBeNull();
    expect(m.container.contains(backdrop)).toBe(false);
    expect(backdrop.parentElement).toBe(document.body);
  });

  it('is a labelled modal dialog', () => {
    m = mount(<Modal title="เลือกช่องจอด" onClose={() => {}}>body</Modal>);
    const card = document.querySelector('.modal-card')!;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    const labelledBy = card.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)!.textContent).toBe('เลือกช่องจอด');
  });

  it('a footer renders after the body, outside it; without one there is no footer', () => {
    m = mount(<Modal title="t" onClose={() => {}} footer={<button type="button">ok</button>}>body</Modal>);
    const foot = document.querySelector('.modal-card > .modal-foot')!;
    expect(foot.textContent).toBe('ok');
    expect(foot.previousElementSibling!.classList.contains('modal-body')).toBe(true);
    m.unmount();
    m = mount(<Modal title="t" onClose={() => {}}>body</Modal>);
    expect(document.querySelector('.modal-foot')).toBeNull();
  });

  it('a footer of null or false renders no footer row', () => {
    m = mount(<Modal title="t" onClose={() => {}} footer={null}>body</Modal>);
    expect(document.querySelector('.modal-foot')).toBeNull();
    m.unmount();
    m = mount(<Modal title="t" onClose={() => {}} footer={false}>body</Modal>);
    expect(document.querySelector('.modal-foot')).toBeNull();
  });

  it('Esc and the backdrop still close it; a click inside does not', () => {
    const onClose = vi.fn();
    m = mount(<Modal title="t" onClose={onClose}><span id="inside">x</span></Modal>);
    act(() => { document.getElementById('inside')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    act(() => { (document.querySelector('.modal-backdrop') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

/** The opener stays in the page; the dialog is shown or not, as callers do it. */
function Harness({ open }: { open: boolean }) {
  return (
    <div>
      <button type="button" id="opener">เปิด</button>
      {open && (
        <Modal title="t" onClose={() => {}} footer={<button type="button" id="last">ตกลง</button>}>
          <input id="first-field" />
        </Modal>
      )}
    </div>
  );
}

function tab(shift = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
  act(() => { (document.activeElement ?? document.body).dispatchEvent(e); });
  return e;
}

describe('Modal focus (aria-modal means focus stays inside)', () => {
  it('moves focus into the dialog on open', () => {
    m = mount(<Harness open={false} />);
    (document.getElementById('opener') as HTMLButtonElement).focus();
    act(() => m!.root.render(<Harness open />));
    const card = document.querySelector('.modal-card')!;
    expect(card.contains(document.activeElement)).toBe(true);
  });

  it('a child that takes focus itself (autoFocus) keeps it', () => {
    m = mount(<Modal title="t" onClose={() => {}}><input id="auto" autoFocus /></Modal>);
    expect(document.activeElement).toBe(document.getElementById('auto'));
  });

  it('gives focus back to the opener when it closes', () => {
    m = mount(<Harness open={false} />);
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();
    act(() => m!.root.render(<Harness open />));
    expect(document.activeElement).not.toBe(opener);
    act(() => m!.root.render(<Harness open={false} />));
    expect(document.activeElement).toBe(opener);
  });

  it('Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last', () => {
    m = mount(<Harness open />);
    const close = document.querySelector('.modal-close') as HTMLButtonElement;
    const last = document.getElementById('last') as HTMLButtonElement;
    last.focus();
    const e1 = tab();
    expect(e1.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const e2 = tab(true);
    expect(e2.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('Tab in the middle is left to the browser', () => {
    m = mount(<Harness open />);
    (document.getElementById('first-field') as HTMLInputElement).focus();
    expect(tab().defaultPrevented).toBe(false);
  });
});
