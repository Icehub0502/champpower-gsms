import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PrintCopySet, PrintResult } from '@gsms/contracts/index.js';
import { thaiDateTime } from '../../lib/printFormat';

/** A-14: the words that tell the two papers apart. Not "ต้นฉบับ/สำเนา" — that pair is for tax invoices (§5.5b). */
const COPY_LABELS: Record<PrintCopySet, string[]> = {
  customer_shop: ['สำหรับลูกค้า', 'สำหรับร้านเก็บ'],
  customer_only: ['สำหรับลูกค้า'],
  shop_only: ['สำหรับร้านเก็บ'],
};

export function printFooterText(result: PrintResult): string {
  return `พิมพ์ครั้งที่ ${result.printNo} · ${thaiDateTime(result.printedAt)} · โดย ${result.printedByName ?? '-'}`;
}

/** The stamps a sheet carries, from the server's answer (A-15 / A-16 / A-18). */
export function printStamps(result: PrintResult): string[] {
  const out: string[] = [];
  if (result.mark === 'draft') out.push('ฉบับร่าง — ยังไม่มีผลผูกพัน');
  if (result.mark === 'void') out.push('ยกเลิก');
  if (result.isReprint) out.push('พิมพ์ซ้ำ');
  return out;
}

interface PrintCopiesProps {
  result: PrintResult;
  shopName: string;
  title: string;
  documentNumber: string | null;
  /** The sheet body, rendered once per copy. */
  children: ReactNode;
  /** Called once the browser's print dialog is done (printed or cancelled — the browser cannot tell us which). */
  onDone: () => void;
}

/**
 * One print job = every copy of the copy set, one after the other, each
 * starting on a new A4 page (§5.5b: two copies, one action). Each copy is a
 * layout table so the browser repeats its header (copy label, title, number,
 * stamps) and its footer ("พิมพ์ครั้งที่ N ...") on every page of a long sheet.
 *
 * Portalled to <body> and hidden on screen; body.gsms-printing hides the app
 * while the print dialog renders, so only these pages reach the paper.
 */
export function PrintCopies({ result, shopName, title, documentNumber, children, onDone }: PrintCopiesProps) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      document.body.classList.remove('gsms-printing');
      doneRef.current();
    };
    document.body.classList.add('gsms-printing');
    window.addEventListener('afterprint', finish);
    // Two frames: the portal is in the DOM and laid out (fonts already loaded by the app) before the dialog snapshots it.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => window.print());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener('afterprint', finish);
      document.body.classList.remove('gsms-printing');
    };
  }, []);

  const stamps = printStamps(result);
  const footer = printFooterText(result);

  return createPortal(
    <div className="print-root" aria-hidden="true">
      {stamps.length > 0 && result.mark && <div className="pr-watermark">{result.mark === 'void' ? 'ยกเลิก' : 'ฉบับร่าง'}</div>}
      {COPY_LABELS[result.copySet].map((label) => (
        <table className="pr-copy" key={label}>
          <thead>
            <tr>
              <td>
                <div className="pr-head">
                  <div className="pr-shop">{shopName}</div>
                  <div className="pr-title">
                    <h1>{title}</h1>
                    {documentNumber && <div className="pr-docno">เลขที่ <span className="mono">{documentNumber}</span></div>}
                  </div>
                  <div className="pr-copy-label">{label}</div>
                </div>
                {stamps.length > 0 && (
                  <div className="pr-stamps">
                    {stamps.map((s) => <span key={s} className="pr-stamp">{s}</span>)}
                  </div>
                )}
              </td>
            </tr>
          </thead>
          <tfoot>
            <tr>
              <td>
                <div className="pr-foot">{footer} · {label}</div>
              </td>
            </tr>
          </tfoot>
          <tbody>
            <tr>
              <td>{children}</td>
            </tr>
          </tbody>
        </table>
      ))}
    </div>,
    document.body,
  );
}
