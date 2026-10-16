import { useEffect, useId, type ReactNode } from 'react';
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

/**
 * Centered dialog with a dimmed backdrop — click the backdrop or Esc to close.
 *
 * Portalled into document.body: rendered in place, any ancestor that makes a
 * stacking context (the sticky top bar at z-index 15, a sticky column) caps
 * the dialog's z-index at its own, and the phone dock (--z-dock) then sits on
 * top of the backdrop. React events still bubble through the React tree, so
 * callers see no difference.
 */
export function Modal({ title, onClose, children, footer }: ModalProps) {
  const titleId = useId();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title" id={titleId}>{title}</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="ปิด">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
