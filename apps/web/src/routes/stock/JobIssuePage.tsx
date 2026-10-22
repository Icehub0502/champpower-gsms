import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatQty, parseQtyNonNegative } from '@champpower/domain';
import {
  StockIssueInput,
  type JobDetail, type JobStock, type JobStockLine, type Role, type StockIssueLineInput, type StockIssueResult,
} from '@gsms/contracts/index.js';
import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import { Icon } from '../../components/ui/Icon';
import { Modal } from '../../components/ui/Modal';
import { PlateBadge } from '../../components/ui/PlateBadge';
import { QtyStepper } from '../../components/ui/QtyStepper';
import { ScanInput } from '../../components/ui/ScanInput';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { qtyText } from '../../lib/printFormat';
import { canReadQuote } from '../quote/quoteLabels';
import { StockNav } from './StockNav';
import { STOCK_CHANGED_EVENT, canIssueStock, canWriteStock, isNegative, jobStockPath, qty, stockRoutes } from './stockLabels';
import { useStockMutation } from './useStockMutation';

/** The route element: /jobs/:jobId/stock. Every role may READ the list; the button is for issue roles. */
export function JobIssueRoute({ role }: { role: Role | null }) {
  const { jobId } = useParams<{ jobId: string }>();
  if (!jobId) return null;
  return (
    <ErrorBoundary key={jobId}>
      <JobIssuePage jobId={jobId} role={role} />
    </ErrorBoundary>
  );
}

interface Pick { selected: boolean; qty: string }

const centi = (v: string | null | undefined) => (v == null ? null : parseQtyNonNegative(v.trim()));

/**
 * เบิกของ ของงานหนึ่งคัน (WO-006 §4, CLAUDE.md s6 item 2): office piles the parts in front of
 * the store room, then presses เบิก here — issue + unreserve together on the server, in one
 * transaction. Only approved part lines with a SKU appear (set PARENT lines are a price,
 * not a thing on a shelf; their children are listed). The way in that always works is
 * tick-and-press; a scanner typing a code + Enter ticks the matching line (and counts up
 * one per scan of the same part).
 *
 * Pulling more than a line has reserved needs an explicit "yes" first (spoiled during
 * fitting, late stock) — allowOverReserved is sent only after that yes.
 */
function JobIssuePage({ jobId, role }: { jobId: string; role: Role | null }) {
  const stock = useDocument<JobStock>(jobStockPath(jobId), STOCK_CHANGED_EVENT);
  const job = useDocument<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`, 'job:changed');
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [scanHint, setScanHint] = useState<{ text: string; error: boolean } | null>(null);
  const [overConfirm, setOverConfirm] = useState<{ lines: StockIssueLineInput[]; over: JobStockLine[] } | null>(null);
  const [result, setResult] = useState<StockIssueResult | null>(null);
  const m = useStockMutation();
  const lastSig = useRef<string | null>(null);
  const mayIssue = canIssueStock(role);
  const data = stock.data;
  const lines = data?.lines ?? [];
  const lineById = new Map(lines.map((l) => [l.lineId, l]));

  const pickOf = (l: JobStockLine): Pick => picks[l.lineId] ?? { selected: false, qty: centi(l.toIssue) ? qtyText(l.toIssue) : '1' };
  const setPick = (l: JobStockLine, p: Partial<Pick>) => setPicks((all) => ({ ...all, [l.lineId]: { ...pickOf(l), ...p } }));
  const selected = lines.filter((l) => !l.done && l.counted && pickOf(l).selected);

  function onScan(code: string) {
    const match = lines.filter((l) => l.skuCode === code && !l.done);
    if (match.length === 0) {
      const any = lines.some((l) => l.skuCode === code);
      setScanHint({ text: any ? `รหัส ${code}: บรรทัดนี้เบิกครบแล้ว` : `รหัส ${code} ไม่อยู่ในรายการของงานนี้`, error: true });
      return;
    }
    const l = match.find((x) => !pickOf(x).selected) ?? match[0]!;
    if (!l.counted) { setScanHint({ text: `${l.name}: ยังไม่ตั้งยอด — ตั้งยอดก่อนจึงเบิกได้`, error: true }); return; }
    const p = pickOf(l);
    // First scan ticks the line at its default quantity; every further scan of the same part counts up one.
    const nextQty = p.selected ? qtyText(formatQty((centi(p.qty) ?? 0) + 100)) : p.qty;
    setPick(l, { selected: true, qty: nextQty });
    setScanHint({ text: `เลือก ${l.name} จำนวน ${nextQty}`, error: false });
  }

  async function send(input: StockIssueLineInput[]) {
    setResult(null);
    // A retry of the SAME lines keeps the requestId (a lost answer is replayed, never cut twice);
    // pressing for a different set of lines after a failure is a new press, so a new id.
    const sig = input.map((x) => x.lineId).sort().join(',');
    if (lastSig.current !== null && lastSig.current !== sig) m.reset();
    lastSig.current = sig;
    const parsed = StockIssueInput.safeParse({ requestId: m.requestId(), lines: input });
    if (!parsed.success) { setScanHint({ text: 'จำนวนที่จะเบิกต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง', error: true }); return; }
    const r = await m.run((requestId) => api.post<StockIssueResult>(`${jobStockPath(jobId)}/issue`, { ...parsed.data, requestId }));
    if (!r) return;
    if (r.ok === true) {
      lastSig.current = null;
      setResult(r.value);
      setPicks({});
      setOverConfirm(null);
      stock.reload?.();
      return;
    }
    // The server's over-reserved refusal (e.g. the reservation shrank since the page loaded): ask, then resend.
    const body = r.failure.body;
    if (body?.error === 'over_reserved_needs_confirm') {
      const l = lineById.get(body.lineId);
      if (l) { m.clearFailure(); setOverConfirm({ lines: input, over: [l] }); }
    } else {
      setOverConfirm(null);
    }
  }

  function start(target: JobStockLine[]) {
    const input: StockIssueLineInput[] = target.map((l) => ({ lineId: l.lineId, qty: pickOf(l).qty.trim() }));
    const over = target.filter((l) => {
      const want = centi(pickOf(l).qty);
      const reserved = centi(l.reserved) ?? 0;
      return want !== null && want > reserved;
    });
    if (over.length > 0) { setOverConfirm({ lines: input, over }); return; }
    void send(input);
  }

  const failure = m.failure;
  const failLine = failure?.body && 'lineId' in failure.body && typeof failure.body.lineId === 'string' ? lineById.get(failure.body.lineId) : undefined;
  const insufficientSku = failure?.body?.error === 'insufficient_on_hand' ? failure.body.skuId : null;
  const notCountedSelected = failure?.body?.error === 'sku_not_counted' ? lines.filter((l) => !l.counted && !l.done) : [];
  const jd = job.data;

  return (
    <div className="qt-page st-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <Link className="back-link" to={stockRoutes.issue}><Icon name="back" size={15} /> เลือกงาน</Link>
          <h1>เบิกของ {jd && <span className="mono">{jd.jobNumber}</span>}</h1>
          {jd && (
            <p className="page-sub">
              {[jd.brand, jd.model].filter(Boolean).join(' ') || 'ไม่ระบุรุ่น'} · สถานะงาน {jd.statusLabel}
              {data?.quotation ? ` · ใบเสนอราคา ${data.quotation.number ?? '(ร่าง)'} ฉบับที่ ${data.quotation.revision}` : ''}
            </p>
          )}
        </div>
        <div className="qt-header-side">
          {jd?.plate && <PlateBadge plate={jd.plate} province={jd.province ?? undefined} size="md" />}
          {data?.awaitingParts && <span className="pill st-pill-awaiting">รออะไหล่</span>}
          {canReadQuote(role) && <Link className="btn secondary small" to={`/jobs/${encodeURIComponent(jobId)}/quote`}>ใบเสนอราคา</Link>}
        </div>
      </header>
      <StockNav role={role} />

      {stock.loading && !data && <div className="page-loading">กำลังโหลด...</div>}
      {stock.error && !data && (
        <div className="empty-state" role="alert">
          โหลดรายการเบิกไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => stock.reload?.()}>ลองใหม่</button></div>
        </div>
      )}
      {stock.error && data && <p className="ci-nomatch" role="status">โหลดล่าสุดไม่สำเร็จ แสดงข้อมูลเดิม</p>}

      {result && <IssueResultCard result={result} onClose={() => setResult(null)} />}

      {data && !data.quotation && <div className="empty-state">งานนี้ยังไม่มีใบเสนอราคา จึงยังไม่มีของให้เบิก</div>}
      {data && data.quotation && lines.length === 0 && data.unboundLines.length === 0 && (
        <div className="empty-state">ใบเสนอราคายังไม่ได้ยืนยันผลลูกค้า หรือไม่มีอะไหล่ที่อนุมัติ — ยังไม่มีของให้เบิก</div>
      )}

      {data && lines.length > 0 && (
        <section className="card" aria-label="อะไหล่ที่ต้องเบิก">
          <h3>อะไหล่ที่ลูกค้าอนุมัติ</h3>
          {mayIssue && <ScanInput onCode={onScan} disabled={m.busy} hint={scanHint?.text} hintIsError={scanHint?.error} />}
          <ul className="st-rows">
            {lines.map((l) => (
              <IssueLine
                key={l.lineId}
                line={l}
                child={l.parentLineId !== null}
                pick={pickOf(l)}
                mayIssue={mayIssue}
                mayCount={canWriteStock(role)}
                busy={m.busy}
                onPick={(p) => setPick(l, p)}
                onIssueNow={() => start([l])}
              />
            ))}
          </ul>
        </section>
      )}

      {data && data.unboundLines.length > 0 && (
        <section className="card st-notice" aria-label="บรรทัดที่ยังไม่ผูกสต๊อก">
          <h3>ยังไม่ผูกสต๊อก — เบิกในระบบไม่ได้</h3>
          <ul>{data.unboundLines.map((u) => <li key={u.lineId}>{u.name}</li>)}</ul>
          <p className="qt-line-sub">
            รายการเหล่านี้ขายได้ แต่ไม่ได้ตัดสต๊อก
            {canWriteStock(role) && <> · <Link to={stockRoutes.links}>ผูกแคตตาล็อกกับสต๊อก</Link></>}
          </p>
        </section>
      )}

      {failure && !overConfirm && (
        <div className="ci-form-error st-block-error" role="alert">
          <span>{failure.text}{failLine ? ` (${failLine.name})` : ''}</span>
          {insufficientSku && canWriteStock(role) && <Link to={stockRoutes.countOne(insufficientSku)}>ถ้าของมีจริง ไปตั้งยอดใหม่</Link>}
          {notCountedSelected.map((l) => canWriteStock(role) && <Link key={l.lineId} to={stockRoutes.countOne(l.skuId)}>ตั้งยอด {l.skuName}</Link>)}
          {failure.retryable && <span>กดเบิกอีกครั้งได้เลย — ถ้ารอบก่อนสำเร็จไปแล้ว ระบบจะไม่ตัดซ้ำ</span>}
        </div>
      )}

      {mayIssue && selected.length > 0 && (
        <div className="st-issue-bar" role="region" aria-label="เบิกที่เลือก">
          <span>เลือกไว้ {selected.length} รายการ</span>
          <button type="button" className="btn hazard" disabled={m.busy} onClick={() => start(selected)}>
            {m.busy ? 'กำลังเบิก...' : `เบิก ${selected.length} รายการ`}
          </button>
        </div>
      )}

      {overConfirm && (
        <Modal
          title="เบิกเกินที่จองไว้"
          onClose={() => { if (!m.busy) setOverConfirm(null); }}
          footer={(
            <div className="row-flex">
              <button
                type="button" className="btn danger" disabled={m.busy}
                onClick={() => {
                  const overIds = new Set(overConfirm.over.map((o) => o.lineId));
                  void send(overConfirm.lines.map((x) => (overIds.has(x.lineId) ? { ...x, allowOverReserved: true } : x)));
                }}
              >
                {m.busy ? 'กำลังเบิก...' : 'ยืนยันเบิกเกิน'}
              </button>
              <button type="button" className="btn secondary" disabled={m.busy} onClick={() => setOverConfirm(null)}>ยกเลิก</button>
            </div>
          )}
        >
          <p>รายการต่อไปนี้จะเบิกมากกว่าที่จองไว้ให้งานนี้ — ส่วนที่เกินจะตัดจากของที่ยังไม่ได้จองให้ใคร</p>
          <ul>
            {overConfirm.over.map((l) => (
              <li key={l.lineId}><strong>{l.name}</strong> — จองไว้ {qty(l.reserved)} · จะเบิก {overConfirm.lines.find((x) => x.lineId === l.lineId)?.qty ?? '-'} {l.unit ?? ''}</li>
            ))}
          </ul>
          <p className="qt-line-sub">ใช้เมื่อของเสียระหว่างติดตั้ง หรือของเพิ่งมาถึง · ถ้าไม่แน่ใจ ให้ยกเลิกแล้วแก้จำนวน</p>
          {m.failure && <p className="ci-form-error" role="alert">{m.failure.text}</p>}
        </Modal>
      )}
    </div>
  );
}

function IssueLine({ line: l, child, pick, mayIssue, mayCount, busy, onPick, onIssueNow }: {
  line: JobStockLine; child: boolean; pick: Pick; mayIssue: boolean; mayCount: boolean; busy: boolean;
  onPick: (p: Partial<Pick>) => void; onIssueNow: () => void;
}) {
  const unit = l.unit ?? '';
  const short = (centi(l.shortfall) ?? 0) > 0;
  const cls = ['st-row', child ? 'st-line-child' : '', l.awaitingParts ? 'is-awaiting' : '', l.done ? 'is-done' : ''].filter(Boolean).join(' ');
  return (
    <li className={cls}>
      <div className="st-row-main">
        <span className="st-name">
          {l.name}
          {l.done && <span className="pill pill-success"> เบิกครบแล้ว</span>}
          {l.awaitingParts && <span className="pill st-pill-awaiting"> รออะไหล่</span>}
        </span>
        <span className="qt-line-sub">
          <span className="mono">{l.skuCode}</span>
          {l.skuName !== l.name ? ` · ${l.skuName}` : ''}
          {l.shelfLocation ? ` · ชั้น ${l.shelfLocation}` : ''}
          {child ? ' · ในชุด' : ''}
        </span>
        <span className="qt-line-sub">
          ต้องใช้ <span className="mono">{qty(l.need)}</span> · จองไว้ <span className="mono">{qty(l.reserved)}</span> · เบิกแล้ว <span className="mono">{qty(l.issued)}</span>
          {short && <> · <strong className="st-neg">ขาด {qty(l.shortfall)} {unit}</strong></>}
        </span>
        <span className="qt-line-sub">
          {l.counted
            ? <>ในสต๊อก: คงเหลือ <span className="mono">{qty(l.onHand)}</span> · พร้อมใช้ <span className={`mono${isNegative(l.available) ? ' st-neg' : ''}`}>{qty(l.available)}</span></>
            : <span className="st-figs-none">ยังไม่ตั้งยอด</span>}
        </span>
      </div>
      {mayIssue && !l.done && (
        <div className="st-row-actions">
          {l.counted ? (
            <>
              <label className="st-tick">
                <input type="checkbox" checked={pick.selected} disabled={busy} onChange={(e) => onPick({ selected: e.target.checked })} />
                <span>เลือก</span>
              </label>
              <QtyStepper label={`จำนวนเบิก (${unit})`} value={pick.qty} disabled={busy} onChange={(v) => onPick({ qty: v, selected: true })} />
              <button type="button" className="btn secondary" disabled={busy || (centi(pick.qty) ?? 0) === 0} onClick={onIssueNow}>เบิกบรรทัดนี้</button>
            </>
          ) : (
            <span className="qt-line-sub">
              ยังไม่ตั้งยอด — ตั้งยอดก่อนจึงเบิกได้
              {mayCount && <> · <Link to={stockRoutes.countOne(l.skuId)}>ไปตั้งยอด</Link></>}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function IssueResultCard({ result: r, onClose }: { result: StockIssueResult; onClose: () => void }) {
  return (
    <section className={`card st-result${r.replayed ? ' is-replay' : ''}`} role="status" aria-label="ผลการเบิก">
      <h3>{r.replayed ? 'รายการนี้เบิกไปแล้วก่อนหน้า (ไม่ตัดซ้ำ)' : 'เบิกแล้ว'}</h3>
      <ul className="st-result-list">
        {r.issued.map((i) => {
          const extra = (centi(i.extra) ?? 0) > 0;
          return (
            <li key={`${i.lineId}-${i.skuId}`}>
              <span className="mono">{i.skuCode}</span> เบิก <strong className="mono">{qty(i.qty)}</strong>
              {' '}(จากที่จอง {qty(i.fromReserved)}{extra ? ` · เกินที่จอง ${qty(i.extra)}` : ''})
            </li>
          );
        })}
      </ul>
      {r.jobStock.awaitingParts && <p className="qt-line-sub">งานนี้ยังมีรายการรออะไหล่</p>}
      <button type="button" className="btn secondary small" onClick={onClose}>ปิด</button>
    </section>
  );
}
