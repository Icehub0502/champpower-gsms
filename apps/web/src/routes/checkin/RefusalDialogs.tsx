import { useState } from 'react';
import type { CustomerCandidate, VehicleCandidate, VehicleOwnerMismatchError } from '@gsms/contracts/index.js';
import { Modal } from '../../components/ui/Modal';
import { ProvincePicker } from '../../components/ui/ProvincePicker';

/**
 * 409 customer_ambiguous — several customers share this phone. The counter
 * picks; the page never picks the first one for them. Name only is shown
 * (that is all the schema lets through).
 */
export function PickCustomerDialog({
  candidates,
  busy,
  onPick,
  onCancel,
}: {
  candidates: CustomerCandidate[];
  busy: boolean;
  onPick: (c: CustomerCandidate) => void;
  onCancel: () => void;
}) {
  return (
    <Modal title="เบอร์นี้มีลูกค้ามากกว่าหนึ่งราย" onClose={onCancel}>
      <div className="ci-dialog">
        <p>กรุณาถามลูกค้าแล้วเลือกว่าเป็นรายไหน</p>
        <div className="ci-dialog-list">
          {candidates.map((c) => (
            <button key={c.id} type="button" className="btn secondary" disabled={busy} onClick={() => onPick(c)}>
              {c.name ?? 'ไม่มีชื่อในระบบ'}
            </button>
          ))}
        </div>
        <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>
          ยกเลิก — กลับไปแก้ข้อมูล
        </button>
      </div>
    </Modal>
  );
}

/**
 * 409 vehicle_owner_mismatch — the plate is on file under someone else.
 * Moving the car merges two people's repair histories and is close to
 * unrecoverable, so it is never confirmed automatically: both names are shown
 * in words and the counter has to press the confirm button themselves.
 */
export function OwnerChangeDialog({
  refusal,
  plate,
  busy,
  onConfirm,
  onCancel,
}: {
  refusal: VehicleOwnerMismatchError;
  plate: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const current = refusal.currentOwner.name ?? 'ลูกค้ารายอื่น';
  const next = refusal.newOwner.name ?? 'ลูกค้ารายนี้';
  return (
    <Modal title="ทะเบียนนี้อยู่ในชื่อลูกค้ารายอื่น" onClose={onCancel}>
      <div className="ci-dialog" role="alertdialog" aria-labelledby="ci-owner-q">
        <dl className="ci-owner-compare">
          <dt>ทะเบียน</dt>
          <dd className="mono">{plate}</dd>
          <dt>เจ้าของในระบบตอนนี้</dt>
          <dd>{current}</dd>
          <dt>ผู้ที่นำรถมาวันนี้</dt>
          <dd>
            {next}
            {refusal.newOwner.id === null && ' (ลูกค้าใหม่)'}
          </dd>
        </dl>
        <p id="ci-owner-q">
          <strong>รถคันนี้เปลี่ยนเจ้าของแล้วใช่ไหม?</strong> ถ้ายืนยัน ประวัติการซ่อมของรถคันนี้จะย้ายไปอยู่กับ “{next}”
          และย้อนกลับได้ยาก — ถ้าเป็นญาติหรือคนขับแทน ให้กด “ไม่ใช่” แล้วแก้ชื่อ/เบอร์ให้เป็นของเจ้าของเดิม
        </p>
        <div className="row-flex">
          <button type="button" className="btn danger" disabled={busy} onClick={onConfirm}>
            ใช่ เปลี่ยนเจ้าของเป็น {next}
          </button>
          <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>
            ไม่ใช่ — กลับไปแก้
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 409 vehicle_ambiguous — this plate is on file as more than one car. Each
 * candidate is a card led by its province (that is what tells two cars with
 * one plate apart); brand, model and colour follow. The schema is strict and
 * carries no owner or phone, so none can appear here. The counter answers one
 * of three ways: "คันนี้" (vehicleId), a province to search with, or "เป็นรถคันใหม่"
 * — which needs the new car's province, so it stays off until one is chosen.
 */
export function VehicleAmbiguousDialog({
  candidates,
  province,
  busy,
  onPickVehicle,
  onPickProvince,
  onNewVehicle,
  onCancel,
}: {
  candidates: VehicleCandidate[];
  /** The province currently on the form ('' if none). */
  province: string;
  busy: boolean;
  onPickVehicle: (c: VehicleCandidate) => void;
  onPickProvince: (province: string) => void;
  onNewVehicle: (province: string) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState(province);
  return (
    <Modal title="ทะเบียนนี้ตรงกับรถมากกว่าหนึ่งคัน" onClose={onCancel}>
      <div className="ci-dialog">
        <p>ดูรถของลูกค้าแล้วเลือกคันที่ตรงกัน ถ้าไม่ใช่คันไหนเลยให้เลือกเป็นรถคันใหม่</p>
        <ul className="ci-dialog-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {candidates.map((c) => {
            const name = `${c.brand} ${c.model}`;
            return (
              <li key={c.id} className="ci-vehicle-card">
                <div>
                  <div className="ci-vehicle-province">{c.province ?? 'ไม่มีจังหวัดในระบบ'}</div>
                  <div className="ci-vehicle-detail">{name}{c.color ? ` · สี${c.color}` : ''}</div>
                </div>
                <button type="button" className="btn" disabled={busy}
                  aria-label={`คันนี้ — ${c.province ?? 'ไม่มีจังหวัด'} ${name}`} onClick={() => onPickVehicle(c)}>
                  คันนี้
                </button>
              </li>
            );
          })}
        </ul>
        <div className="ci-dialog-picker">
          <span className="ci-field-label">หรือเลือกจังหวัดของทะเบียนนี้</span>
          <ProvincePicker value={chosen} onChange={setChosen} disabled={busy} />
        </div>
        <div className="row-flex">
          <button type="button" className="btn secondary" disabled={busy || !chosen} onClick={() => onPickProvince(chosen)}>
            ค้นหาด้วยจังหวัดนี้
          </button>
          <button type="button" className="btn secondary" disabled={busy || !chosen} onClick={() => onNewVehicle(chosen)}>
            เป็นรถคันใหม่
          </button>
        </div>
        {!chosen && <p className="ci-field-hint">เลือกจังหวัดก่อน จึงจะค้นหาหรือบันทึกเป็นรถคันใหม่ได้</p>}
        <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>
          ยกเลิก — กลับไปแก้ข้อมูล
        </button>
      </div>
    </Modal>
  );
}
