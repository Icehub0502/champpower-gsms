import { useId, type KeyboardEvent } from 'react';
import { formatQty, parseQtyNonNegative } from '@champpower/domain';
import { qtyText } from '../../lib/printFormat';

interface QtyStepperProps {
  value: string;
  onChange: (v: string) => void;
  label: string;
  disabled?: boolean;
  error?: string | null;
  /** Fired on Enter — the count sheet saves the row and moves to the next one. */
  onEnter?: () => void;
  /** Marks the input for "focus the next row" keyboard flow. */
  dataKey?: string;
  autoFocus?: boolean;
}

/**
 * A quantity box with − / + either side: a big target on a tablet in the store room, and
 * an ordinary text box for a keyboard. Steps of 1 go through the domain's hundredths
 * parser, never float arithmetic (CLAUDE.md s4), and never below 0. The text itself is
 * what is sent; the contract schema decides whether it is a valid quantity.
 */
export function QtyStepper({ value, onChange, label, disabled, error, onEnter, dataKey, autoFocus }: QtyStepperProps) {
  const id = useId();
  const centi = parseQtyNonNegative(value.trim() === '' ? '0' : value.trim());

  function step(by: number) {
    const base = centi ?? 0;
    const next = Math.max(0, base + by * 100);
    onChange(qtyText(formatQty(next)));
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
  }

  return (
    <label className={`st-qty${error ? ' has-error' : ''}`} htmlFor={id}>
      <span>{label}</span>
      <span className="st-qty-row">
        <button type="button" className="st-qty-step" tabIndex={-1} aria-label={`ลด${label}`} disabled={disabled || centi === null || centi === 0} onClick={() => step(-1)}>−</button>
        <input
          id={id}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="next"
          data-qty-key={dataKey}
          aria-invalid={error ? true : undefined}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
        />
        <button type="button" className="st-qty-step" tabIndex={-1} aria-label={`เพิ่ม${label}`} disabled={disabled || centi === null} onClick={() => step(1)}>+</button>
      </span>
      {error && <span className="ci-field-error">{error}</span>}
    </label>
  );
}

/** Moves focus to the quantity box after `current` in document order (the count sheet's Enter flow). */
export function focusNextQty(current: string) {
  const all = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-qty-key]'));
  const i = all.findIndex((el) => el.dataset.qtyKey === current);
  const next = all.slice(i + 1).find((el) => !el.disabled);
  next?.focus();
}
