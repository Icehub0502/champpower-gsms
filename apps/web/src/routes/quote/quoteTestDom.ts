// DOM helpers for the quotation screen's tests (react-dom + act, the same
// approach as the rest of apps/web's *.test.tsx — no testing-library).
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

export function mount(node: ReactNode): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Let pending promises and timers settle inside act. */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Modals render inside the container, so search the whole document. */
export function buttons(text: string | RegExp): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter((b) =>
    typeof text === 'string' ? (b.textContent ?? '').trim() === text : text.test(b.textContent ?? ''),
  ) as HTMLButtonElement[];
}

export function button(text: string | RegExp): HTMLButtonElement {
  const b = buttons(text)[0];
  if (!b) throw new Error(`no button "${String(text)}"`);
  return b;
}

export function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The input/select inside the label.field whose label text starts with `label`, within `scope`. */
export function field(label: string, scope: ParentNode = document): HTMLInputElement | HTMLSelectElement {
  const lbl = Array.from(scope.querySelectorAll('label.field')).find((l) =>
    (l.querySelector('.ci-field-label')?.textContent ?? '').startsWith(label),
  );
  const el = lbl?.querySelector('input, select, textarea');
  if (!el) throw new Error(`no field "${label}"`);
  return el as HTMLInputElement | HTMLSelectElement;
}

export function type(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

export function submit(form: HTMLFormElement): void {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
