import type { ReactNode } from 'react';

/**
 * A labelled form field with its own error line. The error is words with a ⚠
 * mark, not only a red border — never colour as the only signal
 * (DECISION-7-today.md §4). The input inside should set aria-invalid itself;
 * `errorId` is provided so it can point aria-describedby at the message.
 */
export function CheckInField({
  label,
  required,
  hint,
  error,
  errorId,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  errorId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`field ci-field${error ? ' has-error' : ''}${className ? ` ${className}` : ''}`}>
      <span className="ci-field-label">
        {label}
        {required && <span className="ci-required"> (จำเป็น)</span>}
      </span>
      {children}
      {hint && !error && <span className="ci-field-hint">{hint}</span>}
      {error && (
        <span className="ci-field-error" id={errorId} role="alert">
          ⚠ {error}
        </span>
      )}
    </label>
  );
}
