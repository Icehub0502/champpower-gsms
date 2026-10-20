import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { toQtyCenti } from '@champpower/domain';
import type { Role } from '@gsms/contracts/index.js';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import type {
  ChannelKind, CreatePaymentChannelInput, PatchPaymentChannelInput, PaymentChannel, PaymentChannelList, ReorderPaymentChannelsInput,
} from '../../lib/pendingContracts';
import { describeBillError } from '../bill/billErrors';
import { canManageChannels } from '../bill/billLabels';
import { PAYMENT_CHANNELS_PATH } from '../bill/PaymentPanel';

const KINDS: { kind: ChannelKind; label: string }[] = [
  { kind: 'cash', label: 'เงินสด' },
  { kind: 'transfer', label: 'โอน / QR' },
  { kind: 'card', label: 'บัตร' },
];


/** "3" / "3.5" / "0" — a percent the API accepts: 0-100, at most 2 decimals. null = invalid. */
function percentOk(text: string): string | null {
  const t = text.trim() === '' ? '0' : text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  try {
    return toQtyCenti(t) <= 10000 ? t : null;
  } catch {
    return null;
  }
}

export function PaymentChannelsRoute({ role }: { role: Role | null }) {
  if (!canManageChannels(role)) {
    return (
      <div className="empty-state" role="alert">
        ตั้งค่าช่องทางชำระได้เฉพาะเจ้าของและผู้จัดการ
        <div><Link className="btn secondary" to="/today">กลับหน้างานวันนี้</Link></div>
      </div>
    );
  }
  return <PaymentChannelsPage />;
}

/**
 * ตั้งค่า › ช่องทางชำระ (Ice B3): the shop's own payment buttons — name (the
 * account money lands in, e.g. ออมสิน / คลิก / JPM), kind (cash / transfer /
 * card, which is what the daily summary and change rules go by) and an
 * optional surcharge %. Channels are deactivated, never deleted: old receipts
 * point at them.
 */
export function PaymentChannelsPage() {
  const doc = useDocument<PaymentChannelList>(PAYMENT_CHANNELS_PATH, 'payment-channel:changed');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = [...(doc.data?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);

  async function act(key: string, call: () => Promise<unknown>): Promise<boolean> {
    if (busy !== null) return false;
    setBusy(key);
    setError(null);
    try {
      await call();
      doc.reload?.();
      return true;
    } catch (err) {
      const f = describeBillError(err);
      if (!f.cancelled) setError(f.text);
      return false;
    } finally {
      setBusy(null);
    }
  }

  function move(index: number, delta: number) {
    const ids = items.map((c) => c.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    const body: ReorderPaymentChannelsInput = { ids };
    void act('order', () => api.put(`${PAYMENT_CHANNELS_PATH}/order`, body));
  }

  return (
    <div className="qt-page pc-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>ช่องทางชำระ</h1>
          <p className="page-sub">ปุ่มที่หน้าเก็บเงินจะแสดงตามรายการนี้ เรียงตามลำดับที่ตั้ง · ปิดใช้แทนการลบ เพราะใบเสร็จเก่ายังอ้างถึง</p>
        </div>
      </header>

      {error && <p className="ci-form-error" role="alert">{error}</p>}
      {doc.loading && !doc.data && <div className="page-loading">กำลังโหลด...</div>}
      {doc.error && !doc.data && (
        <div className="empty-state" role="alert">
          โหลดช่องทางชำระไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => doc.reload?.()}>ลองใหม่</button></div>
        </div>
      )}

      {doc.data && (
        <section className="card">
          <h3>รายการ ({items.length})</h3>
          {items.length === 0 && <p className="qt-line-sub">ยังไม่มีช่องทาง — เพิ่มอย่างน้อย “เงินสด” หนึ่งช่องทาง</p>}
          <ul className="pc-list">
            {items.map((c, i) => (
              <ChannelRow
                key={c.id}
                channel={c}
                busy={busy}
                first={i === 0}
                last={i === items.length - 1}
                onMove={(d) => move(i, d)}
                onSave={(patch) => act(`save:${c.id}`, () => api.patch(`${PAYMENT_CHANNELS_PATH}/${encodeURIComponent(c.id)}`, patch))}
              />
            ))}
          </ul>
        </section>
      )}

      {doc.data && (
        <AddChannel busy={busy} onAdd={(input) => act('add', () => api.post(PAYMENT_CHANNELS_PATH, input))} />
      )}
    </div>
  );
}

function ChannelFields({ name, kind, percent, disabled, onName, onKind, onPercent, touched }: {
  name: string; kind: ChannelKind; percent: string; disabled: boolean; touched: boolean;
  onName: (v: string) => void; onKind: (k: ChannelKind) => void; onPercent: (v: string) => void;
}) {
  const nameId = useId();
  const pctId = useId();
  const nameBad = touched && name.trim() === '';
  const pctBad = percentOk(percent) === null;
  return (
    <div className="pc-fields">
      <label className={`field${nameBad ? ' has-error' : ''}`} htmlFor={nameId}>
        <span>ชื่อที่แสดงบนปุ่ม</span>
        <input id={nameId} maxLength={40} value={name} disabled={disabled} placeholder="เช่น ออมสิน, รูดบัตร" onChange={(e) => onName(e.target.value)} />
        {nameBad && <span className="ci-field-error">จำเป็นต้องกรอก</span>}
      </label>
      <div className="field">
        <span>ประเภท</span>
        <div className="row-flex" role="group" aria-label="ประเภทช่องทาง">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" className={`chip${kind === k.kind ? ' active' : ''}`} aria-pressed={kind === k.kind} disabled={disabled} onClick={() => onKind(k.kind)}>
              {kind === k.kind && '✓ '}{k.label}
            </button>
          ))}
        </div>
      </div>
      <label className={`field${pctBad ? ' has-error' : ''}`} htmlFor={pctId}>
        <span>ค่าธรรมเนียม % (เว้นว่าง = ไม่มี)</span>
        <input id={pctId} inputMode="decimal" value={percent} disabled={disabled} placeholder="0" onChange={(e) => onPercent(e.target.value)} />
        {pctBad && <span className="ci-field-error">ใส่ 0–100 ทศนิยมไม่เกิน 2 ตำแหน่ง</span>}
      </label>
    </div>
  );
}

function ChannelRow({ channel, busy, first, last, onMove, onSave }: {
  channel: PaymentChannel; busy: string | null; first: boolean; last: boolean;
  onMove: (delta: number) => void; onSave: (patch: PatchPaymentChannelInput) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(channel.name);
  const [kind, setKind] = useState<ChannelKind>(channel.kind);
  const [percent, setPercent] = useState(channel.surchargePercent.replace(/\.00$/, ''));
  const [touched, setTouched] = useState(false);
  const anyBusy = busy !== null;
  const kindLabel = KINDS.find((k) => k.kind === channel.kind)?.label ?? channel.kind;
  const pct = channel.surchargePercent.replace(/\.00$/, '');

  return (
    <li className={`pc-row${channel.active ? '' : ' is-off'}`}>
      {!editing ? (
        <div className="pc-row-main">
          <span className="pc-name">{channel.name}</span>
          <span className="qt-line-sub">{kindLabel}{pct !== '0' ? ` · ค่าธรรมเนียม +${pct}%` : ''}{channel.active ? '' : ' · ปิดใช้อยู่'}</span>
        </div>
      ) : (
        <form
          className="pc-edit"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            const p = percentOk(percent);
            if (name.trim() === '' || p === null) return;
            void onSave({ name: name.trim(), kind, surchargePercent: p }).then((ok) => { if (ok) setEditing(false); });
          }}
        >
          <ChannelFields name={name} kind={kind} percent={percent} disabled={anyBusy} touched={touched} onName={setName} onKind={setKind} onPercent={setPercent} />
          <div className="row-flex">
            <button type="submit" className="btn small" disabled={anyBusy}>{busy === `save:${channel.id}` ? 'กำลังบันทึก...' : 'บันทึก'}</button>
            <button type="button" className="btn secondary small" disabled={anyBusy} onClick={() => setEditing(false)}>ยกเลิก</button>
          </div>
        </form>
      )}
      {!editing && (
        <div className="pc-row-actions">
          <button type="button" className="btn secondary small" disabled={anyBusy || first} aria-label={`เลื่อน ${channel.name} ขึ้น`} onClick={() => onMove(-1)}>↑</button>
          <button type="button" className="btn secondary small" disabled={anyBusy || last} aria-label={`เลื่อน ${channel.name} ลง`} onClick={() => onMove(1)}>↓</button>
          <button type="button" className="btn secondary small" disabled={anyBusy} onClick={() => setEditing(true)}>แก้</button>
          <button
            type="button"
            className={`btn small ${channel.active ? 'danger' : 'secondary'}`}
            disabled={anyBusy}
            onClick={() => void onSave({ active: !channel.active })}
          >
            {channel.active ? 'ปิดใช้' : 'เปิดใช้'}
          </button>
        </div>
      )}
    </li>
  );
}

function AddChannel({ busy, onAdd }: { busy: string | null; onAdd: (input: CreatePaymentChannelInput) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ChannelKind>('transfer');
  const [percent, setPercent] = useState('');
  const [touched, setTouched] = useState(false);
  const anyBusy = busy !== null;
  return (
    <section className="card">
      <h3>เพิ่มช่องทาง</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          const p = percentOk(percent);
          if (name.trim() === '' || p === null) return;
          void onAdd({ name: name.trim(), kind, surchargePercent: p }).then((ok) => {
            if (ok) { setName(''); setPercent(''); setTouched(false); }
          });
        }}
      >
        <ChannelFields name={name} kind={kind} percent={percent} disabled={anyBusy} touched={touched} onName={setName} onKind={setKind} onPercent={setPercent} />
        <button type="submit" className="btn" disabled={anyBusy}>{busy === 'add' ? 'กำลังเพิ่ม...' : 'เพิ่มช่องทาง'}</button>
      </form>
    </section>
  );
}
