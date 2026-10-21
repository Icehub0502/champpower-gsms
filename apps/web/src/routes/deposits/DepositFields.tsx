import { useId, useRef, useState } from 'react';
import { depositAmountIssue, depositExpectedDateIssue } from '@champpower/domain';
import type {
  DepositChannel, DepositReason, DepositSlipFile, PaymentChannelList,
} from '@gsms/contracts/index.js';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { resizeImageToBlob } from '../../lib/compressImage';
import { bangkokTodayKey } from '../../lib/printFormat';
import { PAYMENT_CHANNELS_PATH } from '../bill/PaymentPanel';
import {
  DEPOSIT_CHANNELS, DEPOSIT_CHANNEL_LABEL, DEPOSIT_REASONS, DEPOSIT_REASON_LABEL,
} from './depositLabels';

/** What the counter types for one deposit, before it becomes a CreateDepositInput. */
export interface DepositDraft {
  amount: string;
  paymentChannelId: string;
  reason: DepositReason | '';
  /** YYYY-MM-DD (the date input's own format). */
  expectedDate: string;
  channel: DepositChannel;
  /** หมายเหตุ (internal, optional, max 500). DEFAULT pending Ice (note is internal, not printed on the DEP slip). */
  note: string;
}

export const EMPTY_DRAFT: DepositDraft = { amount: '', paymentChannelId: '', reason: '', expectedDate: '', channel: 'walk_in', note: '' };

export type DraftField = keyof DepositDraft | 'slip';
export type DraftErrors = Partial<Record<DraftField, string>>;

/**
 * The front gate (CLAUDE.md §4.y): the same domain checks the API runs, so the
 * counter sees a field error before anything is sent. The server checks again.
 */
export function checkDraft(d: DepositDraft, today: string = bangkokTodayKey()): DraftErrors {
  const e: DraftErrors = {};
  const amount = d.amount.trim();
  if (amount === '') e.amount = 'กรอกยอดมัดจำ';
  else {
    const issue = depositAmountIssue(amount);
    if (issue === 'invalid_money') e.amount = 'จำนวนเงินไม่ถูกต้อง — ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง';
    else if (issue === 'must_be_positive') e.amount = 'ยอดมัดจำต้องมากกว่า 0';
  }
  if (!d.paymentChannelId) e.paymentChannelId = 'เลือกช่องทางที่รับเงิน';
  if (!d.reason) e.reason = 'เลือกเหตุผลที่รับมัดจำ';
  if (!d.expectedDate) e.expectedDate = 'กรอกวันที่ลูกค้านัดว่าจะเอารถเข้า (จำเป็น)';
  else {
    const issue = depositExpectedDateIssue(d.expectedDate, today);
    if (issue === 'invalid_date') e.expectedDate = 'วันที่ไม่ถูกต้อง';
    else if (issue === 'in_the_past') e.expectedDate = 'วันที่นัดต้องไม่ก่อนวันนี้';
  }
  if (d.note.trim().length > 500) e.note = 'หมายเหตุยาวเกิน 500 ตัวอักษร';
  return e;
}

export type SlipState =
  | { status: 'none' }
  | { status: 'uploading'; name: string }
  | { status: 'done'; name: string; fileId: string }
  | { status: 'failed'; name: string; file: File };

/** The transfer slip image: resized, then uploaded straight away (POST /api/files/deposit-slip). */
export function useSlipUpload() {
  const [slip, setSlip] = useState<SlipState>({ status: 'none' });
  const seq = useRef(0);

  async function pick(file: File) {
    const mine = ++seq.current;
    setSlip({ status: 'uploading', name: file.name });
    try {
      const blob = await resizeImageToBlob(file);
      const fd = new FormData();
      fd.append('file', blob, 'slip.jpg');
      const uploaded = await api.upload<DepositSlipFile>('/api/files/deposit-slip', fd);
      if (mine === seq.current) setSlip({ status: 'done', name: file.name, fileId: uploaded.id });
    } catch (err) {
      if (isSessionCancelled(err) || mine !== seq.current) return;
      setSlip({ status: 'failed', name: file.name, file });
    }
  }

  function clear() {
    seq.current += 1;
    setSlip({ status: 'none' });
  }

  return { slip, pick, clear };
}
export type SlipUpload = ReturnType<typeof useSlipUpload>;

interface DepositFieldsProps {
  draft: DepositDraft;
  errors: DraftErrors;
  disabled: boolean;
  onChange: (patch: Partial<DepositDraft>) => void;
  slip: SlipUpload;
  /** Online deposits (no car yet) ask how the customer reached the shop; at the counter it is walk-in by default. */
  showChannel: boolean;
}

/**
 * The deposit fields shared by the counter dialog and /deposits/new: amount,
 * the shop's payment channel, reason, the expected day (mandatory), the slip.
 */
export function DepositFields({ draft, errors, disabled, onChange, slip, showChannel }: DepositFieldsProps) {
  const ids = { amount: useId(), date: useId(), slip: useId(), note: useId() };
  const channelsDoc = useDocument<PaymentChannelList>(PAYMENT_CHANNELS_PATH, 'payment-channel:changed');
  const channels = (channelsDoc.data?.items ?? []).filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const today = bangkokTodayKey();

  return (
    <div className="dp-fields">
      {showChannel && (
        <fieldset className="dp-group">
          <legend className="ci-field-label">ลูกค้าติดต่อมาทาง</legend>
          <div className="dp-chips" role="group">
            {DEPOSIT_CHANNELS.map((c) => (
              <button key={c} type="button" className={`chip${draft.channel === c ? ' active' : ''}`} aria-pressed={draft.channel === c}
                disabled={disabled} onClick={() => onChange({ channel: c })}>
                {DEPOSIT_CHANNEL_LABEL[c]}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <label className={`field ci-field${errors.amount ? ' has-error' : ''}`} htmlFor={ids.amount}>
        <span className="ci-field-label">ยอดมัดจำ (บาท)</span>
        <input id={ids.amount} inputMode="decimal" placeholder="เช่น 1000" value={draft.amount} disabled={disabled}
          aria-invalid={errors.amount ? true : undefined} onChange={(e) => onChange({ amount: e.target.value })} />
        {errors.amount && <span className="ci-field-error">{errors.amount}</span>}
      </label>

      <fieldset className={`dp-group${errors.paymentChannelId ? ' has-error' : ''}`}>
        <legend className="ci-field-label">รับเงินทาง</legend>
        {channelsDoc.error && !channelsDoc.data && (
          <p className="ci-form-error" role="alert">
            โหลดช่องทางชำระไม่สำเร็จ <button type="button" className="btn secondary small" onClick={() => channelsDoc.reload?.()}>ลองใหม่</button>
          </p>
        )}
        {channelsDoc.data && channels.length === 0 && (
          <p className="ci-form-error" role="alert">สาขานี้ยังไม่ได้ตั้งช่องทางชำระ — ให้เจ้าของตั้งที่ ตั้งค่า › ช่องทางชำระ</p>
        )}
        <div className="dp-chips" role="group">
          {channels.map((c) => (
            <button key={c.id} type="button" className={`chip bl-method${draft.paymentChannelId === c.id ? ' active' : ''}`}
              aria-pressed={draft.paymentChannelId === c.id} disabled={disabled} onClick={() => onChange({ paymentChannelId: c.id })}>
              {draft.paymentChannelId === c.id && '✓ '}{c.name}
            </button>
          ))}
        </div>
        {errors.paymentChannelId && <span className="ci-field-error">{errors.paymentChannelId}</span>}
      </fieldset>

      <fieldset className={`dp-group${errors.reason ? ' has-error' : ''}`}>
        <legend className="ci-field-label">เหตุผลที่รับมัดจำ</legend>
        <div className="dp-chips" role="group">
          {DEPOSIT_REASONS.map((r) => (
            <button key={r} type="button" className={`chip${draft.reason === r ? ' active' : ''}`} aria-pressed={draft.reason === r}
              disabled={disabled} onClick={() => onChange({ reason: r })}>
              {DEPOSIT_REASON_LABEL[r]}
            </button>
          ))}
        </div>
        {errors.reason && <span className="ci-field-error">{errors.reason}</span>}
      </fieldset>

      <label className={`field ci-field${errors.expectedDate ? ' has-error' : ''}`} htmlFor={ids.date}>
        <span className="ci-field-label">วันที่ลูกค้านัดว่าจะเอารถเข้า (จำเป็น)</span>
        <input id={ids.date} type="date" min={today} value={draft.expectedDate} disabled={disabled}
          aria-invalid={errors.expectedDate ? true : undefined} onChange={(e) => onChange({ expectedDate: e.target.value })} />
        {errors.expectedDate && <span className="ci-field-error">{errors.expectedDate}</span>}
        <span className="qt-line-sub">เลยวันนี้แล้วลูกค้ายังไม่มา ระบบจะขึ้นเตือนในหน้า “มัดจำค้างอยู่” ทันที</span>
      </label>

      <label className={`field ci-field${errors.note ? ' has-error' : ''}`} htmlFor={ids.note}>
        <span className="ci-field-label">หมายเหตุ (ถ้ามี)</span>
        <textarea id={ids.note} rows={2} maxLength={500} value={draft.note} disabled={disabled}
          aria-invalid={errors.note ? true : undefined} onChange={(e) => onChange({ note: e.target.value })} />
        {errors.note && <span className="ci-field-error">{errors.note}</span>}
        <span className="qt-line-sub">บันทึกภายในร้าน ไม่พิมพ์บนใบรับเงินมัดจำ</span>
      </label>

      <div className={`field ci-field${errors.slip ? ' has-error' : ''}`}>
        <span className="ci-field-label">รูปสลิปโอนเงิน <span className="ci-required">(ไม่บังคับ)</span></span>
        <SlipPicker id={ids.slip} slip={slip} disabled={disabled} />
        {errors.slip && <span className="ci-field-error">{errors.slip}</span>}
      </div>
    </div>
  );
}

function SlipPicker({ id, slip, disabled }: { id: string; slip: SlipUpload; disabled: boolean }) {
  const s = slip.slip;
  return (
    <div className="dp-slip">
      {s.status === 'none' && (
        <label className="btn secondary small" htmlFor={id}>
          แนบรูปสลิป
          <input id={id} className="dp-file" type="file" accept="image/*" disabled={disabled}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void slip.pick(f); }} />
        </label>
      )}
      {s.status === 'uploading' && <span className="qt-line-sub" role="status">กำลังอัปโหลดสลิป...</span>}
      {s.status === 'done' && (
        <>
          <span className="pill pill-success">แนบสลิปแล้ว</span>
          <button type="button" className="btn secondary small" disabled={disabled} onClick={slip.clear}>เอาออก</button>
        </>
      )}
      {s.status === 'failed' && (
        <>
          <span className="ci-field-error">อัปโหลดสลิปไม่สำเร็จ</span>
          <button type="button" className="btn secondary small" disabled={disabled} onClick={() => void slip.pick(s.file)}>ลองใหม่</button>
          <button type="button" className="btn secondary small" disabled={disabled} onClick={slip.clear}>เอาออก</button>
        </>
      )}
    </div>
  );
}

/** The slip blocks saving only while it is on the wire or failed: it is never dropped silently. */
export function slipError(slip: SlipState): string | null {
  if (slip.status === 'uploading') return 'รอสลิปอัปโหลดให้เสร็จก่อน';
  if (slip.status === 'failed') return 'สลิปอัปโหลดไม่สำเร็จ — กด “ลองใหม่” หรือ “เอาออก” ก่อนบันทึก';
  return null;
}
