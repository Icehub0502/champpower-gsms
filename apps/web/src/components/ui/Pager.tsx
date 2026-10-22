interface PagerProps {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
  disabled?: boolean;
}

/**
 * ก่อนหน้า / ถัดไป for an offset-paged list (contracts PageQuery). Renders nothing when
 * everything fits on one page. The range text says how many there are in all, so "50
 * rows" is never mistaken for "everything".
 */
export function Pager({ offset, limit, total, onChange, disabled }: PagerProps) {
  if (total <= limit && offset === 0) return null;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav className="row-flex ui-pager" aria-label="เปลี่ยนหน้า">
      <button type="button" className="btn secondary small" disabled={disabled || offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        ก่อนหน้า
      </button>
      <span className="qt-line-sub" aria-live="polite">{from}–{to} จาก {total}</span>
      <button type="button" className="btn secondary small" disabled={disabled || offset + limit >= total} onClick={() => onChange(offset + limit)}>
        ถัดไป
      </button>
    </nav>
  );
}
