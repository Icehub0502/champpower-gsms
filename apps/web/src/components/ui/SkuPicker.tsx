import { useEffect, useId, useRef, useState } from 'react';
import type { SkuPage, SkuRow } from '@gsms/contracts/index.js';
import { ApiError, api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { SKUS_PATH, skuByCodePath } from '../../routes/stock/stockLabels';
import { CameraScanButton } from './CameraScan';
import { Icon } from './Icon';
import { StockFigures } from './StockFigures';

interface SkuPickerProps {
  onPick: (sku: SkuRow) => void;
  label?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Include deactivated SKUs in the search (the SKU master list). Default: active only. */
  includeInactive?: boolean;
}

const SEARCH_LIMIT = 10;

/**
 * Find one SKU: type to search (name or code), or scan. The guaranteed path is search
 * and pick (WO-006 §4). Enter looks the text up as an exact code first — that is what a
 * USB / Bluetooth scanner sends (skus.code + Enter) — and falls back to the search list
 * when no SKU has that code. Every row shows พร้อมใช้ or "ยังไม่ตั้งยอด", so the person
 * picking can tell the two apart before choosing.
 */
export function SkuPicker({ onPick, label = 'ค้นหาอะไหล่ (ชื่อ / รหัส) หรือสแกน', disabled, autoFocus, includeInactive }: SkuPickerProps) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<SkuRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const id = useId();
  const listId = `${id}-list`;

  // Debounced search: one request per pause in typing, and only the newest answer is applied.
  useEffect(() => {
    const q = text.trim();
    if (q === '') { setResults(null); setLoading(false); return; }
    const mine = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      const params = new URLSearchParams({ q, limit: String(SEARCH_LIMIT), offset: '0', active: includeInactive ? 'all' : 'active' });
      api.get<SkuPage>(`${SKUS_PATH}?${params}`)
        .then((page) => {
          if (mine !== seq.current) return;
          setResults(page.items);
          setTotal(page.total);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (mine !== seq.current || isSessionCancelled(err)) return;
          setLoading(false);
          setNote('ค้นหาไม่สำเร็จ ลองใหม่อีกครั้ง');
        });
    }, 300);
    return () => window.clearTimeout(t);
  }, [text, includeInactive]);

  function pick(sku: SkuRow) {
    seq.current += 1;
    setText('');
    setResults(null);
    setNote(null);
    onPick(sku);
  }

  async function lookupCode(raw: string) {
    const code = raw.trim();
    if (!code) return;
    setNote(null);
    try {
      const sku = await api.get<SkuRow>(skuByCodePath(code));
      pick(sku);
    } catch (err) {
      if (isSessionCancelled(err)) return;
      if (err instanceof ApiError && err.status === 404) {
        setText(code);
        setNote(`ไม่พบอะไหล่รหัส “${code}” — เลือกจากผลค้นหาด้านล่าง หรือพิมพ์ชื่อแทน`);
        return;
      }
      setNote('ค้นหารหัสไม่สำเร็จ ลองใหม่อีกครั้ง');
    }
  }

  return (
    <div className="st-picker">
      <div className="st-scan">
        <label className="field ci-field st-scan-field" htmlFor={id}>
          <span className="ci-field-label">{label}</span>
          <span className="st-scan-row">
            <Icon name="search" size={16} />
            <input
              id={id}
              value={text}
              disabled={disabled}
              autoFocus={autoFocus}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="search"
              role="combobox"
              aria-expanded={results !== null}
              aria-controls={listId}
              placeholder="เช่น ลูกหมาก หรือ CP-0142 แล้วกด Enter"
              onChange={(e) => { setText(e.target.value); setNote(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void lookupCode(text); }
                if (e.key === 'Escape') { setText(''); setResults(null); }
              }}
            />
          </span>
          {note && <span className="ci-field-error" role="status">{note}</span>}
        </label>
        <CameraScanButton onCode={(c) => void lookupCode(c)} disabled={disabled} />
      </div>
      {text.trim() !== '' && (
        <ul className="st-picker-list" id={listId} role="listbox" aria-label="ผลค้นหาอะไหล่">
          {loading && results === null && <li className="qt-line-sub st-picker-empty">กำลังค้นหา...</li>}
          {results !== null && results.length === 0 && <li className="qt-line-sub st-picker-empty">ไม่พบอะไหล่ที่ตรงกับ “{text.trim()}”</li>}
          {results?.map((s) => (
            <li key={s.id} role="option" aria-selected={false}>
              <button type="button" className="st-picker-row" disabled={disabled} onClick={() => pick(s)}>
                <span className="st-picker-main">
                  <span className="st-name">{s.name}{!s.isActive && <span className="pill pill-muted"> ปิดใช้งาน</span>}</span>
                  <span className="qt-line-sub"><span className="mono">{s.code}</span>{s.shelfLocation ? ` · ชั้น ${s.shelfLocation}` : ''}</span>
                </span>
                <StockFigures sku={s} compact />
              </button>
            </li>
          ))}
          {results !== null && total > results.length && (
            <li className="qt-line-sub st-picker-empty">แสดง {results.length} จาก {total} รายการ — พิมพ์ให้เจาะจงขึ้น</li>
          )}
        </ul>
      )}
    </div>
  );
}
