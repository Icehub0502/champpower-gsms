import { useState } from 'react';
import type { DecideLineInput, PatchLineInput, Quotation, QuotationLine } from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import type { QuoteFailure } from './quoteErrors';
import { QuoteLineRow, type LineActions, type RowMode } from './QuoteLineRow';
import { groupLines, isRevision, revisionMark, type LineGroup } from './quoteView';
import { quotationPath, type QuotationState } from './useQuotation';

interface QuoteLinesProps {
  jobId: string;
  quotation: Quotation;
  canWrite: boolean;
  busy: string | null;
  run: QuotationState['run'];
}

/**
 * The lines of the quotation (panel A's "รายการที่เลือก"). Draft: edit qty /
 * price / remove. Issued: approve or decline each line, set heads AND their
 * pieces (D10) — what that does to the rest of the set is decided by the
 * server (applySetDecision) and shown as it answers.
 */
export function QuoteLines({ jobId, quotation, canWrite, busy, run }: QuoteLinesProps) {
  const [failures, setFailures] = useState<Record<string, QuoteFailure>>({});
  const base = quotationPath(jobId);
  const mode: RowMode = !canWrite ? 'view' : quotation.next.canEditContent ? 'draft' : quotation.next.canDecide ? 'decide' : 'view';
  const needsAmount = new Set(quotation.next.setsNeedingAmountLineIds);
  const groups = groupLines(quotation.lines);

  async function act(line: QuotationLine, what: string, call: () => Promise<Quotation>): Promise<boolean> {
    setFailures((f) => {
      const rest = { ...f };
      delete rest[line.id];
      return rest;
    });
    const result = await run(`${what}:${line.id}`, call);
    if (!result.ok && !result.failure.cancelled) {
      setFailures((f) => ({ ...f, [line.id]: result.failure }));
    }
    return result.ok;
  }

  const patch = (line: QuotationLine, body: PatchLineInput, what = 'edit') =>
    act(line, what, () => api.patch<Quotation>(`${base}/lines/${encodeURIComponent(line.id)}`, body));
  const decide = (line: QuotationLine, what: string, body: DecideLineInput) =>
    act(line, what, () => api.patch<Quotation>(`${base}/lines/${encodeURIComponent(line.id)}/decision`, body));

  const actions: LineActions = {
    onQty: (line, qty) => void patch(line, { qty }),
    onPrice: (line, unitPrice) => patch(line, { unitPrice }, 'price'),
    onRemove: (line) => void act(line, 'remove', () => api.del<Quotation>(`${base}/lines/${encodeURIComponent(line.id)}`)),
    onApprove: (line) => void decide(line, 'approve', { decision: 'approved' }),
    onDecline: (line, reason, note) => decide(line, 'decline', note === undefined ? { decision: 'declined', reason } : { decision: 'declined', reason, note }),
  };

  function renderGroup(g: LineGroup) {
    return (
      <ul className="qt-group" key={g.head.id}>
        <QuoteLineRow
          line={g.head}
          isChild={false}
          childCount={g.children.length}
          mode={mode}
          revision={revisionMark(quotation, g.head)}
          needsAmount={needsAmount.has(g.head.id)}
          busyKey={busy}
          failure={failures[g.head.id] ?? null}
          actions={actions}
        />
        {g.children.map((c) => (
          <QuoteLineRow
            key={c.id}
            line={c}
            isChild
            childCount={0}
            // A set piece is decided (D10), never edited on its own.
            mode={mode === 'draft' ? 'view' : mode}
            revision={null}
            needsAmount={false}
            busyKey={busy}
            failure={failures[c.id] ?? null}
            actions={actions}
          />
        ))}
      </ul>
    );
  }

  if (groups.length === 0) {
    return <p className="empty-state">ยังไม่มีรายการ — ค้นหาแล้วกดเพิ่มจากช่องค้นหา</p>;
  }

  if (!isRevision(quotation)) {
    return <div className="qt-lines">{groups.map(renderGroup)}</div>;
  }

  // A revision splits what the customer already agreed to from what must be
  // asked again, so the counter does not re-ask settled lines or skip new ones.
  const carried = groups.filter((g) => g.head.decisionCarriedFrom !== null);
  const fresh = groups.filter((g) => g.head.decisionCarriedFrom === null);
  return (
    <div className="qt-lines">
      {fresh.length > 0 && (
        <section className="qt-lines-section" aria-label="ต้องถามลูกค้าใหม่">
          <h4>ต้องถามลูกค้าใหม่ <span className="qt-line-sub">(รายการใหม่หรือที่แก้ในฉบับนี้)</span></h4>
          {fresh.map(renderGroup)}
        </section>
      )}
      {carried.length > 0 && (
        <section className="qt-lines-section" aria-label="ลูกค้าตกลงไว้แล้ว">
          <h4>ลูกค้าตกลงไว้แล้ว <span className="qt-line-sub">(ผลเดิมจากฉบับก่อน)</span></h4>
          {carried.map(renderGroup)}
        </section>
      )}
    </div>
  );
}
