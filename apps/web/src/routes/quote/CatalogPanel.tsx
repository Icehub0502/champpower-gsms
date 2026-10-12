import { useId, useRef, useState, type ReactNode } from 'react';
import type { AddLineInput, CatalogHit, Quotation, SearchSection } from '@gsms/contracts/index.js';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api/client';
import { baht } from '../../lib/money';
import { FirstPriceEntry } from './FirstPriceEntry';
import { FreeLineForm } from './FreeLineForm';
import { MIN_QUERY, useCatalogSearch } from './useCatalogSearch';
import { quotationPath, type QuotationState } from './useQuotation';

const SECTION_LABEL: Record<SearchSection, string> = {
  set: 'ชุด / แพ็กเกจ',
  frequent: 'ร้านขายบ่อย',
  offered: 'เคยเสนอให้รถคันนี้',
  other: 'รายการอื่น',
};

interface CatalogPanelProps {
  jobId: string;
  busyKey: string | null;
  run: QuotationState['run'];
  guard: QuotationState['guard'];
  /** From the quotation view: false = the car is not matched to a controlled model yet. */
  vehicleModelLinked: boolean;
  /** "เลือกรุ่นรถ" / "เพิ่มรุ่นใหม่", shown under the notice when the car is not matched. */
  modelPicker: ReactNode;
}

/** What to send for a hit: a set is expanded by the server, an offered item re-added by its own id. */
function addBody(hit: CatalogHit, unitPrice: string | undefined): AddLineInput | null {
  const price = unitPrice === undefined ? {} : { unitPrice };
  if (hit.section === 'offered' && hit.offeredItemId) return { kind: 'offered', offeredItemId: hit.offeredItemId };
  if (!hit.itemId) return null;
  return hit.isSet ? { kind: 'set', itemId: hit.itemId, ...price } : { kind: 'item', itemId: hit.itemId, ...price };
}

/**
 * Panel A's picker (D14): one search box, results as you type, keyboard all
 * the way (↑ ↓ choose, Enter adds) — "choosing" must be faster than typing a
 * line by hand (v2 §7). The order and the price for this car are the
 * server's; this panel never prices anything.
 */
export function CatalogPanel({ jobId, busyKey, run, guard, vehicleModelLinked, modelPicker }: CatalogPanelProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [needPrice, setNeedPrice] = useState<(CatalogHit & { itemId: string }) | null>(null);
  const [freeOpen, setFreeOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const search = useCatalogSearch(jobId, query);
  const hits = search.result?.items ?? [];
  const busy = busyKey !== null;

  async function add(hit: CatalogHit, unitPrice: string | undefined, doneNotice: string | null): Promise<boolean> {
    const body = addBody(hit, unitPrice);
    if (!body) return false;
    setError(null);
    const result = await run('add', () => api.post<Quotation>(`${quotationPath(jobId)}/lines`, body));
    if (!result.ok) {
      if (!result.failure.cancelled) setError(result.failure.text);
      return false;
    }
    setNotice(doneNotice ?? `เพิ่ม “${hit.name}” แล้ว`);
    setNeedPrice(null);
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
    return true;
  }

  function choose(hit: CatalogHit) {
    if (busy) return;
    setNotice(null);
    // No price for this car yet: ask for the first one (D8) instead of adding a 0-baht line.
    if (hit.price === null && hit.itemId && hit.section !== 'offered') {
      setNeedPrice({ ...hit, itemId: hit.itemId });
      return;
    }
    void add(hit, undefined, null);
  }

  return (
    <section className="card qt-catalog" aria-label="เพิ่มรายการ">
      <h3><Icon name="search" size={16} /> เพิ่มรายการ</h3>
      <div className="search-wrap qt-search">
        <Icon name="search" size={16} />
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
          placeholder="พิมพ์ค้นหาอะไหล่/รายการ เช่น โช๊ค, ลูกหมาก, น้ำมัน..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); setNotice(null); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            // Enter waits for the answer to what is typed NOW — never adds a hit for an earlier, shorter query.
            if (e.key === 'Enter') { e.preventDefault(); const h = hits[active]; if (h && !search.loading) choose(h); }
          }}
        />
      </div>

      {!vehicleModelLinked && (
        <div className="ci-nomatch qt-unlinked">
          รถคันนี้ยังไม่ได้จับคู่กับรุ่นในรายการ — ราคาที่เห็นเป็นราคากลางทั่วไป
          {modelPicker}
        </div>
      )}
      {notice && <p className="ci-match" role="status">{notice}</p>}
      {error && <p className="ci-form-error" role="alert">{error}</p>}
      {search.error && <p className="ci-form-error" role="alert">ค้นหาไม่สำเร็จ — ลองพิมพ์ใหม่อีกครั้ง</p>}

      {needPrice && (
        <FirstPriceEntry
          key={needPrice.itemId}
          jobId={jobId}
          hit={needPrice}
          busyKey={busyKey}
          guard={guard}
          onAdd={(unitPrice, n) => add(needPrice, unitPrice, n)}
          onCancel={() => setNeedPrice(null)}
        />
      )}

      {query.trim().length >= MIN_QUERY && !search.loading && search.result && hits.length === 0 && (
        <p className="qt-line-sub">ไม่พบ “{query.trim()}” — เพิ่มเป็นรายการใหม่ได้ด้านล่าง</p>
      )}

      {hits.length > 0 && (
        <ul id={listId} className="qt-hits" role="listbox" aria-label="ผลการค้นหา">
          {hits.map((h, i) => {
            const heading = i === 0 || hits[i - 1]!.section !== h.section ? SECTION_LABEL[h.section] : null;
            return (
              <li key={`${h.section}-${h.itemId ?? h.offeredItemId ?? i}`} role="presentation">
                {heading && <div className="qt-hits-heading">{heading}</div>}
                <button
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`qt-hit${i === active ? ' is-active' : ''}`}
                  disabled={busy}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(h)}
                >
                  <span className="qt-hit-name">
                    {h.name}
                    {h.isSet && <span className="pill pill-info">ชุด {h.componentCount} รายการ</span>}
                  </span>
                  <span className="qt-hit-price mono">{h.price === null ? 'ยังไม่มีราคา' : baht(h.price)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {freeOpen ? (
        <FreeLineForm
          jobId={jobId}
          initialName={query.trim()}
          busyKey={busyKey}
          run={run}
          onDone={() => { setFreeOpen(false); setQuery(''); setNotice('เพิ่มรายการใหม่แล้ว'); }}
          onCancel={() => setFreeOpen(false)}
        />
      ) : (
        <button type="button" className="btn secondary" disabled={busy} onClick={() => setFreeOpen(true)}>
          <Icon name="plus" size={15} /> เพิ่มรายการใหม่
        </button>
      )}
    </section>
  );
}
