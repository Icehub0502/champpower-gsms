import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CreateDepositInput, type CreateDepositResult, type Role } from '@gsms/contracts/index.js';
import { DepositSlipPrintButton } from '../../components/print/DepositSlipPrintButton';
import { Icon } from '../../components/ui/Icon';
import { baht } from '../../lib/money';
import { dateKeyThai } from '../../lib/printFormat';
import { api } from '../../lib/api/client';
import { digits, useCheckInLookups } from '../checkin/useCheckInLookups';
import { describeDepositError } from './depositErrors';
import {
  DepositFields, EMPTY_DRAFT, checkDraft, slipError, useSlipUpload, type DepositDraft, type DraftErrors,
} from './DepositFields';
import { HeldDepositWarning } from './HeldDepositWarning';
import {
  DEPOSITS_PATH, DEPOSIT_CHANNEL_LABEL, DEPOSIT_REASON_LABEL, canWriteDeposit, newIdempotencyKey,
} from './depositLabels';

/** The route element: /deposits/new. */
export function NewDepositRoute({ role }: { role: Role | null }) {
  if (!canWriteDeposit(role)) {
    return (
      <div className="empty-state" role="alert">
        รับมัดจำได้เฉพาะหน้าร้าน ผู้จัดการ และเจ้าของ
        <div><Link className="btn secondary" to="/today">กลับหน้างานวันนี้</Link></div>
      </div>
    );
  }
  return <NewDepositPage />;
}

type CustomerErrors = { customerName?: string; customerPhone?: string };

/**
 * มัดจำออนไลน์ (CLAUDE.md §5.4 item 2): the customer messaged the page / LINE /
 * phoned and transferred money — no car, no job, nothing to queue yet. Only
 * name + phone are needed; the API creates a minimal customer, or the counter
 * picks the one already on file from the phone lookup. The slip printed after
 * saving is the customer's only proof, since nobody met face to face.
 */
export function NewDepositPage() {
  const ids = { name: useId(), phone: useId() };
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [useExisting, setUseExisting] = useState<string | null>(null);
  const [draft, setDraft] = useState<DepositDraft>({ ...EMPTY_DRAFT, channel: 'page' });
  const [errors, setErrors] = useState<DraftErrors & CustomerErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [saved, setSaved] = useState<CreateDepositResult | null>(null);
  const slip = useSlipUpload();
  const keyRef = useRef(newIdempotencyKey());
  const lookups = useCheckInLookups();
  const look = lookups.phoneLookup && digits(lookups.phoneLookup.phone) === digits(phone) ? lookups.phoneLookup : null;

  function touched() {
    keyRef.current = newIdempotencyKey();
  }

  function change(patch: Partial<DepositDraft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch) as (keyof DepositDraft)[]) delete next[k];
      return next;
    });
    touched();
  }

  async function onPhoneBlur() {
    const res = await lookups.lookupPhone(phone);
    // A single match is offered, not forced: the counter sees the name and chooses.
    if (res?.kind === 'found') {
      setUseExisting(res.result.customerId);
      if (!name.trim() && res.result.name) setName(res.result.name);
    } else setUseExisting(null);
  }

  async function save() {
    if (busyRef.current) return;
    setFormError(null);
    const found: DraftErrors & CustomerErrors = checkDraft(draft);
    const slipProblem = slipError(slip.slip);
    if (slipProblem) found.slip = slipProblem;
    if (!useExisting) {
      if (!name.trim()) found.customerName = 'กรอกชื่อลูกค้า';
      if (!phone.trim()) found.customerPhone = 'กรอกเบอร์โทรลูกค้า — ใช้เตือนตอนลูกค้าเอารถมา';
    }
    const candidate = {
      idempotencyKey: keyRef.current,
      ...(useExisting ? { customerId: useExisting } : { customerName: name.trim(), customerPhone: phone.trim() }),
      channel: draft.channel,
      reason: draft.reason,
      amount: draft.amount.trim(),
      paymentChannelId: draft.paymentChannelId,
      expectedDate: draft.expectedDate,
      ...(draft.note.trim() !== '' ? { note: draft.note.trim() } : {}),
      ...(slip.slip.status === 'done' ? { slipFileId: slip.slip.fileId } : {}),
    };
    const parsed = CreateDepositInput.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const k = issue.path[0];
        if (k === 'customerPhone' && !found.customerPhone) found.customerPhone = 'เบอร์โทรไม่ถูกต้อง — ตัวเลข 9–10 หลัก';
        if (k === 'customerName' && !found.customerName) found.customerName = 'กรอกชื่อลูกค้า';
      }
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) {
      setFormError('กรุณาแก้ช่องที่มีข้อความแจ้งเตือนก่อนบันทึก');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      setSaved(await api.post<CreateDepositResult>(DEPOSITS_PATH, parsed.data));
    } catch (err) {
      const failure = describeDepositError(err);
      if (failure.cancelled) return;
      setErrors((e) => ({ ...e, ...failure.fields }));
      setFormError(failure.text);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function again() {
    setSaved(null);
    setName('');
    setPhone('');
    setUseExisting(null);
    setDraft({ ...EMPTY_DRAFT, channel: 'page' });
    setErrors({});
    slip.clear();
    keyRef.current = newIdempotencyKey();
  }

  if (saved) {
    const d = saved.deposit;
    return (
      <div className="page dp-page">
        <header className="qt-header">
          <div className="qt-header-main">
            <Link className="back-link" to="/deposits"><Icon name="back" size={15} /> มัดจำค้างอยู่</Link>
            <h1>รับมัดจำแล้ว</h1>
          </div>
        </header>
        <section className="card dp-done" role="status">
          <p className="dp-done-amount">รับมัดจำ <strong className="mono">{baht(d.amount)}</strong></p>
          <dl className="bl-kv">
            <dt>ลูกค้า</dt><dd>{d.customerName ?? '-'} · {d.customerPhone ?? '-'}</dd>
            <dt>ผลการค้นหาลูกค้า</dt>
            <dd>{saved.customerCreated ? 'ลูกค้าใหม่ — สร้างจากชื่อและเบอร์โทร' : 'ลูกค้าเดิมในระบบ'}</dd>
            <dt>เหตุผล</dt><dd>{DEPOSIT_REASON_LABEL[d.reason]}</dd>
            <dt>ติดต่อทาง</dt><dd>{DEPOSIT_CHANNEL_LABEL[d.channel]}</dd>
            <dt>รับเงินทาง</dt><dd>{d.paymentChannelName ?? '-'}</dd>
            <dt>นัดเอารถเข้า</dt><dd>{dateKeyThai(d.expectedDate)}</dd>
          </dl>
          {saved.replayed && <p className="qt-line-sub">รายการนี้บันทึกไปแล้วก่อนหน้า (กดซ้ำ) — แสดงรายการเดิม ไม่มีการรับเงินซ้ำ</p>}
          <p className="qt-line-sub">พิมพ์ใบรับเงินมัดจำ (ออกเลข DEP ตอนพิมพ์ครั้งแรก) แล้วส่งรูปให้ลูกค้าเป็นหลักฐาน — ลูกค้าไม่ได้มาที่ร้าน</p>
          <div className="row-flex">
            {d.next.canPrintSlip && <DepositSlipPrintButton depositId={d.id} className="btn hazard" />}
            <button type="button" className="btn secondary" onClick={again}>รับมัดจำรายการใหม่</button>
            <Link className="btn secondary" to="/deposits">ไปหน้ามัดจำค้างอยู่</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page dp-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <Link className="back-link" to="/deposits"><Icon name="back" size={15} /> มัดจำค้างอยู่</Link>
          <h1>รับมัดจำ (ยังไม่มีรถ)</h1>
          <p className="page-sub">ลูกค้าโอนมาทางเพจ / LINE / โทรศัพท์ ก่อนเอารถเข้า — ใช้แค่ชื่อกับเบอร์โทร</p>
        </div>
      </header>

      <form className="card dp-form" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h3>ลูกค้า</h3>
        <div className="ci-grid ci-grid-2">
          <label className={`field ci-field${errors.customerPhone ? ' has-error' : ''}`} htmlFor={ids.phone}>
            <span className="ci-field-label">เบอร์โทร</span>
            <input id={ids.phone} inputMode="tel" autoComplete="off" value={phone} disabled={busy}
              aria-invalid={errors.customerPhone ? true : undefined}
              onChange={(e) => { setPhone(e.target.value); lookups.phoneEdited(e.target.value); setUseExisting(null); setErrors((x) => ({ ...x, customerPhone: undefined })); touched(); }}
              onBlur={() => void onPhoneBlur()} />
            {errors.customerPhone && <span className="ci-field-error">{errors.customerPhone}</span>}
          </label>
          <label className={`field ci-field${errors.customerName ? ' has-error' : ''}`} htmlFor={ids.name}>
            <span className="ci-field-label">ชื่อลูกค้า</span>
            <input id={ids.name} autoComplete="off" value={name} disabled={busy || useExisting !== null}
              aria-invalid={errors.customerName ? true : undefined}
              onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, customerName: undefined })); touched(); }} />
            {errors.customerName && <span className="ci-field-error">{errors.customerName}</span>}
          </label>
        </div>

        {/* What the API matched for this phone (GET /api/checkin/customer-lookup). */}
        {look?.kind === 'found' && (
          <div className="ci-match" role="status">
            {useExisting
              ? <>ใช้ลูกค้าเดิมในระบบ: <b>{look.result.name ?? 'ไม่มีชื่อ'}</b> ({look.result.vehicles.length} คันในประวัติ)</>
              : <>เบอร์นี้มีลูกค้าเดิม <b>{look.result.name ?? 'ไม่มีชื่อ'}</b> แต่เลือกบันทึกเป็นลูกค้าใหม่</>}
            {' '}
            <button type="button" className="btn secondary small" disabled={busy}
              onClick={() => { setUseExisting(useExisting ? null : look.result.customerId); touched(); }}>
              {useExisting ? 'ไม่ใช่คนนี้ — สร้างลูกค้าใหม่' : 'ใช้ลูกค้าเดิม'}
            </button>
          </div>
        )}
        {look?.kind === 'ambiguous' && (
          <div className="ci-match" role="status">
            เบอร์นี้มีลูกค้าหลายคน เลือกคนที่ใช่:
            <div className="dp-chips">
              {look.candidates.map((c) => (
                <button key={c.id} type="button" className={`chip${useExisting === c.id ? ' active' : ''}`} disabled={busy}
                  onClick={() => { setUseExisting(useExisting === c.id ? null : c.id); if (c.name) setName(c.name); touched(); }}>
                  {c.name ?? 'ไม่มีชื่อ'}
                </button>
              ))}
            </div>
          </div>
        )}
        {look?.kind === 'none' && <p className="ci-nomatch">ไม่พบเบอร์นี้ในระบบ — จะสร้างลูกค้าใหม่จากชื่อและเบอร์โทร</p>}
        {look?.kind === 'found' && (look.result.heldDeposits ?? []).length > 0 && (
          <HeldDepositWarning warnings={look.result.heldDeposits} jobId={null} canAttach={false} />
        )}

        <h3>มัดจำ</h3>
        <DepositFields draft={draft} errors={errors} disabled={busy} onChange={change} slip={slip} showChannel />

        {formError && <p className="ci-form-error" role="alert"><Icon name="alert" size={15} /><span>{formError}</span></p>}
        <div className="ci-actions">
          <button type="submit" className="btn ci-submit" disabled={busy || slip.slip.status === 'uploading'}>
            {busy ? 'กำลังบันทึก…' : 'บันทึกรับมัดจำ'}
          </button>
        </div>
      </form>
    </div>
  );
}
