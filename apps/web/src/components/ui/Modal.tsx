import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * Optional action row, rendered OUTSIDE the scrolling body so it stays in
   * view however long the body gets (a 390px phone, a 1180x820 iPad). A form
   * in the body reaches a submit button here through its `form` attribute.
   */
  footer?: ReactNode;
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Centered dialog with a dimmed backdrop — click the backdrop or Esc to close.
 *
 * Portalled into document.body: rendered in place, any ancestor that makes a
 * stacking context (the sticky top bar at z-index 15, a sticky column) caps
 * the dialog's z-index at its own, and the phone dock (--z-dock) then sits on
 * top of the backdrop. React events still bubble through the React tree, so
 * callers see no difference.
 *
 * aria-modal is a promise the page behind is out of reach, so focus is kept
 * inside: moved in on open, Tab / Shift+Tab wrap at the ends, and on close it
 * goes back to whatever opened the dialog (the portal put the dialog at the
 * end of <body>, far from its opener in tab order).
 */
export function Modal({ title, onClose, children, footer }: ModalProps) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Mount-only: focus in, trap Tab, give focus back on close.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A child that took focus itself (autoFocus) keeps it; otherwise the card, so a screen
    // reader starts at the dialog's title rather than on the × button.
    if (!card.contains(document.activeElement)) card.focus();

    function onTab(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !card) return;
      // Only the topmost dialog traps: a dialog opened from a dialog sits later in <body>.
      const backdrops = document.querySelectorAll('.modal-backdrop');
      if (backdrops[backdrops.length - 1] !== card.parentElement) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const outside = !card.contains(active);
      if (e.shiftKey && (active === first || active === card || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onTab);
    return () => {
      document.removeEventListener('keydown', onTab);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={cardRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title" id={titleId}>{title}</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="ปิด">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer != null && footer !== false && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
