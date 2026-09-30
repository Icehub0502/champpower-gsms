import { Fragment, useEffect, useId, useRef, useState, type Ref } from 'react';
import { BETONG, PLATE_AREAS, isPlateArea, normaliseProvince } from '@champpower/domain';

interface ProvincePickerProps {
  /** '' (nothing chosen) or one of PLATE_AREAS — never anything else. */
  value: string;
  onChange: (province: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
}

/** Names containing the typed text, prefix matches first. "กทม" finds กรุงเทพมหานคร. */
export function filterProvinces(query: string): string[] {
  const q = query.trim();
  if (!q) return [...PLATE_AREAS];
  const alias = normaliseProvince(q);
  const hits = PLATE_AREAS.filter((p) => p.includes(q) || p === alias);
  return [...hits.filter((p) => p.startsWith(q) || p === alias), ...hits.filter((p) => !p.startsWith(q) && p !== alias)];
}

/**
 * Combobox over the 77 official provinces. It can only ever EMIT a valid name
 * or '' — half-typed text is never passed on, because the same plate in two
 * spellings of one province would be two different cars. No default is chosen
 * for the counter; the list simply opens in official order (กรุงเทพมหานคร
 * happens to be first, which is where most plates are from).
 */
export function ProvincePicker({ value, onChange, disabled, readOnly, invalid, describedBy, inputRef }: ProvincePickerProps) {
  const listId = useId();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // What this component last emitted, so an outside change (a prefill, a
  // reset) is copied into the box but our own '' for half-typed text is not.
  const emitted = useRef(value);
  useEffect(() => {
    if (value !== emitted.current) setQuery(value);
    emitted.current = value;
  }, [value]);

  const options = filterProvinces(query);
  const inert = disabled || readOnly;
  const unresolved = query.trim() !== '' && !isPlateArea(query.trim());

  function emit(next: string) {
    emitted.current = next;
    onChange(next);
  }

  function choose(name: string) {
    setQuery(name);
    setOpen(false);
    if (name !== value) emit(name);
  }

  function onType(text: string) {
    setQuery(text);
    setOpen(true);
    setActive(0);
    const exact = text.trim();
    if (isPlateArea(exact)) {
      if (exact !== value) emit(exact);
    } else if (value !== '') {
      emit('');
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const n = options.length;
      if (n > 0) setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === 'Enter' && open) {
      // Enter picks from the list; it must never submit the form underneath.
      e.preventDefault();
      const pick = options[active];
      if (pick) choose(pick);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="prov-picker">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        enterKeyHint="done"
        placeholder="พิมพ์หรือเลือกจังหวัด"
        value={query}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(e) => onType(e.target.value)}
        onClick={() => !inert && setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {open && !inert && (
        <ul id={listId} role="listbox" className="prov-list" aria-label="จังหวัด">
          {options.length === 0 ? (
            <li className="prov-empty" role="presentation">ไม่พบจังหวัดที่ตรงกับที่พิมพ์</li>
          ) : (
            options.map((p, i) => (
              <Fragment key={p}>
              {p === BETONG && <li role="presentation" className="prov-group">ป้ายพิเศษ (ไม่ใช่จังหวัด)</li>}
              <li
                id={`${listId}-${i}`}
                role="option"
                aria-selected={p === value}
                className={`prov-option${i === active ? ' is-active' : ''}${p === value ? ' is-chosen' : ''}`}
                // pointerdown + preventDefault keeps focus in the input, so the
                // blur that closes the list does not swallow the tap.
                onPointerDown={(e) => {
                  e.preventDefault();
                  choose(p);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {p === value && '✓ '}{p}
                {p === BETONG && <span className="prov-note">ป้ายเบตง (ยะลา)</span>}
              </li>
              </Fragment>
            ))
          )}
        </ul>
      )}
      {unresolved && !open && <span className="prov-hint">⚠ ยังไม่ได้เลือก — กดเลือกจังหวัดจากรายการ</span>}
    </div>
  );
}
