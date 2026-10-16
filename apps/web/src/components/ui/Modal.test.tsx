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
