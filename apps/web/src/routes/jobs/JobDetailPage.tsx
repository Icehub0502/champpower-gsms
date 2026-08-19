import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import {
  buildLineSummaryText,
  DECISION_KEYS,
  estMinutes,
  etaState,
  fmtDT,
  fmtMoney,
  isDecisionPoint,
  jobDiscountAmount,
  jobGrandTotal,
  jobInBay,
  jobPartsTotal,
  nextStatusOf,
  prevStatusOf,
  repairCycle,
  statusOf,
  todayKey,
  WARRANTY_OPTIONS,
  warrantyOptionLabel,
  warrantyStatus,
  WORK_BAYS,
  type Customer,
  type Job,
  type PartNeeded,
  type ShopConfig,
  type Vehicle,
  type VehicleModel,
} from '@champpower/domain';
import { db } from '../../lib/firebase/client';
import { syncBoardEntry } from '../../lib/firebase/board';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';
import { StatusLabel, StatusTrack } from '../../components/job/StatusTrack';
import { PlateBadge } from '../../components/ui/PlateBadge';
import { SignaturePad } from '../../components/job/SignaturePad';
import { compressImage } from '../../lib/compressImage';

function newId() {
  return crypto.randomUUID();
}

function splitMins(total: number) {
  const t = Math.max(0, Math.round(total || 0));
  return { d: Math.floor(t / 1440), h: Math.floor((t % 1440) / 60), m: t % 60 };
}

export function JobDetailPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const jobs = useCollection<Job>('jobs');
  const vehicles = useCollection<Vehicle>('vehicles');
  const customers = useCollection<Customer>('customers');
  const models = useCollection<VehicleModel>('models');
  const config = useDocument<ShopConfig>('config', 'main');
  const technicians = config.data?.technicians || [];

  const [schedulingDate, setSchedulingDate] = useState<string | null>(null);
  const [techInput, setTechInput] = useState('');
  const [showTechInput, setShowTechInput] = useState(false);
  const [warrantyDays, setWarrantyDays] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [customPart, setCustomPart] = useState({ name: '', qty: '1', unit: 'ชิ้น', brand: '', price: '' });
  const [copyStatus, setCopyStatus] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const job = jobs.rows.find((j) => j.id === jobId);
  const vehicle = job ? vehicles.rows.find((v) => v.id === job.vehicleId) : undefined;
  const customer = job ? customers.rows.find((c) => c.id === job.customerId) : undefined;
  const activeJobs = useMemo(() => jobs.rows.filter((j) => !j.deletedAt), [jobs.rows]);

  const matchedModel = useMemo(() => {
    if (!vehicle) return undefined;
    const brand = (vehicle.brand || '').trim().toUpperCase();
    const name = (vehicle.model || '').trim().toUpperCase();
    if (!brand && !name) return undefined;
    return models.rows.find(
      (m) => m.brand.trim().toUpperCase() === brand && m.name.trim().toUpperCase() === name,
    );
  }, [models.rows, vehicle]);

  if (jobs.loading) return <div className="page-loading">กำลังโหลด...</div>;
  if (!job) return <div className="empty-state">ไม่พบงานนี้</div>;

  const jobRef = doc(db, 'jobs', job.id);
  const nowIso = () => new Date().toISOString();

  async function pushStatus(status: Job['status'], extra: Record<string, unknown> = {}) {
    if (!job) return;
    setBusy(true);
    try {
      const statusHistory = [...job.statusHistory, { status, changedAt: nowIso() }];
      await updateDoc(jobRef, { status, statusHistory, ...extra });
      await syncBoardEntry({ ...job, status, statusHistory, ...extra }, vehicle);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSchedule() {
    if (!schedulingDate) return;
    await pushStatus('scheduled', { appointmentDate: schedulingDate });
    setSchedulingDate(null);
  }

  async function assignTechnician(name: string) {
    const trimmed = name.trim();
    if (!job || trimmed === (job.technician || '')) return;
    setBusy(true);
    try {
      if (trimmed && !technicians.some((t) => t.name === trimmed)) {
        await setDoc(
          doc(db, 'config', 'main'),
          { technicians: [...technicians, { id: newId(), name: trimmed }] },
          { merge: true },
        );
      }
      await updateDoc(jobRef, {
        technician: trimmed,
        technicianHistory: [
          ...(job.technicianHistory || []),
          { name: trimmed, changedAt: nowIso() },
        ],
      });
      setShowTechInput(false);
      setTechInput('');
    } finally {
      setBusy(false);
    }
  }

  async function assignBay(bay: string) {
    if (!job) return;
    setBusy(true);
    try {
      const occupant = bay ? jobInBay(activeJobs, bay, job.id) : null;
      if (occupant) {
        await updateDoc(doc(db, 'jobs', occupant.id), { bay: '' });
      }
      await updateDoc(jobRef, { bay });
      await syncBoardEntry({ ...job, bay }, vehicle);
    } finally {
      setBusy(false);
    }
  }

  async function setEstMinutesTotal(totalMins: number) {
    if (!job) return;
    const value = Math.max(0, Math.round(totalMins));
    await updateDoc(jobRef, { estValue: value, estUnit: 'minute' });
    await syncBoardEntry({ ...job, estValue: value, estUnit: 'minute' }, vehicle);
  }

  async function saveWarranty() {
    await updateDoc(jobRef, { warrantyDays });
  }

  async function savePartsNeeded(next: PartNeeded[]) {
    if (!job) return;
    await updateDoc(jobRef, { partsNeeded: next });
  }

  function togglePartFromModel(mp: VehicleModel['parts'][number]) {
    if (!job) return;
    const existing = job.partsNeeded.find((p) => p.name === mp.partName);
    if (existing) {
      savePartsNeeded(job.partsNeeded.filter((p) => p.id !== existing.id));
      return;
    }
    const firstBrand = mp.brands?.[0];
    savePartsNeeded([
      ...job.partsNeeded,
      {
        id: newId(),
        name: mp.partName,
        qty: mp.qty || '1',
        unit: mp.unit || 'ชิ้น',
        brand: firstBrand?.name || '',
        price: firstBrand?.price || '',
      },
    ]);
  }

  function addAllFromModel() {
    if (!job || !matchedModel) return;
    const usedNames = new Set(job.partsNeeded.map((p) => p.name));
    const additions: PartNeeded[] = matchedModel.parts
      .filter((mp) => !usedNames.has(mp.partName))
      .map((mp) => ({
        id: newId(),
        name: mp.partName,
        qty: mp.qty || '1',
        unit: mp.unit || 'ชิ้น',
        brand: mp.brands?.[0]?.name || '',
        price: mp.brands?.[0]?.price || '',
      }));
    if (additions.length) savePartsNeeded([...job.partsNeeded, ...additions]);
  }

  function addCustomPart() {
    if (!job) return;
    const name = customPart.name.trim();
    if (!name) return;
    savePartsNeeded([
      ...job.partsNeeded,
      { id: newId(), name, qty: customPart.qty.trim(), unit: customPart.unit.trim(), brand: customPart.brand.trim(), price: customPart.price.trim() },
    ]);
    setCustomPart({ name: '', qty: '1', unit: 'ชิ้น', brand: '', price: '' });
  }

  function updatePartField(id: string, patch: Partial<PartNeeded>) {
    if (!job) return;
    savePartsNeeded(job.partsNeeded.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function removePart(id: string) {
    if (!job) return;
    savePartsNeeded(job.partsNeeded.filter((p) => p.id !== id));
  }

  async function saveDiscount(patch: { discountType?: Job['discountType']; discountValue?: number | string }) {
    await updateDoc(jobRef, patch);
  }

  async function saveSignature(role: 'inspector' | 'quoter' | 'customer', dataUrl: string) {
    await updateDoc(jobRef, { signatures: { ...(job?.signatures || {}), [role]: dataUrl } });
  }

  async function onPhotoPicked(file: File | undefined) {
    if (!file || !job) return;
    setUploadingPhoto(true);
    try {
      const dataUrl = await compressImage(file);
      await updateDoc(jobRef, { thumb: dataUrl, photoCount: (job.photoCount || 0) + 1 });
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function copyLineSummary() {
    if (!job) return;
    const text = buildLineSummaryText(job, vehicle, customer);
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('คัดลอกข้อความแล้ว');
    } catch {
      setCopyStatus('คัดลอกไม่สำเร็จ — เลือกข้อความแล้วคัดลอกเอง');
    }
    setTimeout(() => setCopyStatus(''), 2500);
  }

  const next = nextStatusOf(job);
  const prev = prevStatusOf(job);
  const atDecision = isDecisionPoint(job.status);
  const cycle = repairCycle(job);
  const eta = etaState(estMinutes(job), cycle.start, cycle.end);
  const warranty = warrantyStatus(job);
  const dhm = splitMins(estMinutes(job));
  const partsSubtotal = jobPartsTotal(job);
  const discountAmt = jobDiscountAmount(job);
  const grandTotal = jobGrandTotal(job);
  const lineSummaryText = buildLineSummaryText(job, vehicle, customer);
  const usedPartNames = new Set(job.partsNeeded.map((p) => p.name));
  const partsByCategory = useMemo(() => {
    if (!matchedModel) return [] as { category: string; items: VehicleModel['parts'] }[];
    const groups = new Map<string, VehicleModel['parts']>();
    for (const p of matchedModel.parts) {
      const cat = p.category || 'ทั่วไป';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(p);
    }
    return Array.from(groups.entries()).map(([category, items]) => ({ category, items }));
  }, [matchedModel]);

  return (
    <div className="page">
      <div className="row-flex no-print" style={{ justifyContent: 'space-between' }}>
        <button className="back-link" onClick={() => navigate('/jobs')}>
          ‹ กลับไปรายการงาน
        </button>
        <button className="secondary-btn" onClick={() => window.print()}>
          พิมพ์ใบงาน
        </button>
      </div>

      <div className="card">
        <div className="job-card-top">
          <PlateBadge plate={vehicle?.plate} province={vehicle?.province} size="lg" />
          <StatusLabel status={job.status} />
        </div>
        <h2>{vehicle ? `${vehicle.brand} ${vehicle.model}` : 'ไม่ทราบรุ่นรถ'}</h2>
        <p className="page-sub">
          {job.jobNumber} {customer?.name && `· ${customer.name}`} {customer?.phone && `· ${customer.phone}`}
          {job.bay && ` · จอดที่ ${job.bay}`}
        </p>
        {vehicle && (
          <p className="page-sub" style={{ marginTop: -14 }}>
            {[vehicle.year, vehicle.color, vehicle.mileage ? `ไมล์ ${vehicle.mileage} กม.` : ''].filter(Boolean).join(' · ')}
          </p>
        )}

        <StatusTrack status={job.status} />

        {job.complaints?.length > 0 && (
          <div className="complaint-chips">
            {job.complaints.map((c, i) => (
              <span className="chip active" key={i}>
                {c.text}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card no-print">
        <h3>สถานะงาน</h3>

        {atDecision ? (
          <div className="decision-row">
            <p className="field-label">ลูกค้าตอบว่า</p>
            <div className="row-flex">
              {DECISION_KEYS.map((key) => (
                <button
                  key={key}
                  className={`decision-btn st-${key}`}
                  disabled={busy}
                  onClick={() => (key === 'scheduled' ? setSchedulingDate(todayKey()) : pushStatus(key))}
                >
                  {statusOf(key).label}
                </button>
              ))}
            </div>
            {schedulingDate !== null && (
              <div className="row-flex" style={{ marginTop: 10 }}>
                <input type="date" value={schedulingDate} onChange={(e) => setSchedulingDate(e.target.value)} />
                <button onClick={confirmSchedule} disabled={busy}>
                  ยืนยันวันนัด
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="row-flex">
            {prev && (
              <button className="secondary-btn" disabled={busy} onClick={() => pushStatus(prev.key)}>
                ‹ ย้อนกลับ ({prev.label})
              </button>
            )}
            {next && (
              <button className="next-btn" disabled={busy} onClick={() => pushStatus(next.key)}>
                ถัดไป: {next.label} ›
              </button>
            )}
            {!next && !prev && <span className="page-sub">จบขั้นตอนแล้ว</span>}
          </div>
        )}

        {job.appointmentDate && (
          <p className="field-label" style={{ marginTop: 10 }}>
            นัดหมาย: {job.appointmentDate}
          </p>
        )}
      </div>

      <div className="card">
        <h3>ช่างผู้รับผิดชอบ</h3>
        {job.technician && <p>ตอนนี้: <b>{job.technician}</b></p>}
        {!showTechInput ? (
          <div className="row-flex no-print" style={{ flexWrap: 'wrap' }}>
            {technicians.map((t) => (
              <button key={t.id} className="chip" disabled={busy} onClick={() => assignTechnician(t.name)}>
                {t.name}
              </button>
            ))}
            <button className="chip" onClick={() => setShowTechInput(true)}>
              + พิมพ์ชื่อใหม่
            </button>
          </div>
        ) : (
          <div className="row-flex no-print">
            <input value={techInput} onChange={(e) => setTechInput(e.target.value)} placeholder="ชื่อช่าง" />
            <button disabled={busy} onClick={() => assignTechnician(techInput)}>
              บันทึก
            </button>
          </div>
        )}
      </div>

      {job.bay && (
        <p className="page-sub print-only-bay">บ่อจอด: {job.bay}</p>
      )}
      <div className="card no-print">
        <h3>บ่อจอด</h3>
        <div className="row-flex" style={{ flexWrap: 'wrap' }}>
          {WORK_BAYS.map((bay) => {
            const occupant = jobInBay(activeJobs, bay, job.id);
            return (
              <button
                key={bay}
                className={`chip ${job.bay === bay ? 'active' : ''}`}
                disabled={busy}
                title={occupant ? `ตอนนี้มี ${occupant.id === job.id ? 'งานนี้' : 'งานอื่น'}จอดอยู่` : 'ว่าง'}
                onClick={() => assignBay(job.bay === bay ? '' : bay)}
              >
                {bay}
                {occupant && occupant.id !== job.id ? ' •' : ''}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h3>รูปภาพ</h3>
        <div className="row-flex no-print">
          <label className="btn secondary small photo-input-btn">
            ถ่ายรูปรถ
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => onPhotoPicked(e.target.files?.[0])}
            />
          </label>
          <label className="btn secondary small photo-input-btn">
            อัพโหลดรูปภาพ
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => onPhotoPicked(e.target.files?.[0])}
            />
          </label>
          {uploadingPhoto && <span className="page-sub">กำลังบันทึกรูป...</span>}
        </div>
        {job.thumb && <img className="job-photo-preview" src={job.thumb} alt="รูปรถ" />}
      </div>

      <div className="card">
        <h3>รายการอะไหล่ / เสนอราคา ({job.partsNeeded.length})</h3>
        <p className="page-sub" style={{ marginTop: -8 }}>
          เพิ่มรายการหลังช่างตรวจเช็คเสร็จ แล้วกด &quot;พิมพ์ใบเสนอราคา&quot; ด้านล่างเพื่อเสนอลูกค้า
        </p>

        {job.partsNeeded.length === 0 ? (
          <div className="empty-state" style={{ padding: 18 }}>
            ยังไม่มีรายการอะไหล่ — เลือกจากรายการด้านล่าง หรือกด &quot;+ เพิ่มรายการเอง&quot;
          </div>
        ) : (
          <div className="table-wrap">
            <table className="parts-table">
              <thead>
                <tr>
                  <th>รายการ</th>
                  <th>จำนวน</th>
                  <th>แบรนด์</th>
                  <th>ราคา/หน่วย</th>
                  <th className="center">รวม</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {job.partsNeeded.map((p) => {
                  const qty = parseFloat(p.qty || '1') || 1;
                  const price = parseFloat(p.price || '0') || 0;
                  return (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>
                        <input
                          className="model-part-qty"
                          defaultValue={p.qty}
                          onBlur={(e) => updatePartField(p.id, { qty: e.target.value })}
                          style={{ width: 60 }}
                        />
                        {p.unit ? ` ${p.unit}` : ''}
                      </td>
                      <td>
                        <input
                          defaultValue={p.brand}
                          onBlur={(e) => updatePartField(p.id, { brand: e.target.value })}
                          style={{ width: 90 }}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          defaultValue={p.price}
                          onBlur={(e) => updatePartField(p.id, { price: e.target.value })}
                          style={{ width: 90 }}
                        />
                      </td>
                      <td className="center">{price ? fmtMoney(price * qty) : '-'}</td>
                      <td>
                        <button className="chip-remove-btn" onClick={() => removePart(p.id)}>
                          ลบ
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {partsSubtotal > 0 && (
          <div className="quote-totals">
            <div className="row-flex" style={{ alignItems: 'center' }}>
              <span className="field-label">ส่วนลด</span>
              <select
                value={job.discountType || 'amount'}
                onChange={(e) => saveDiscount({ discountType: e.target.value as Job['discountType'] })}
                style={{ width: 100 }}
              >
                <option value="amount">บาท</option>
                <option value="percent">%</option>
              </select>
              <input
                type="number"
                defaultValue={job.discountValue}
                onBlur={(e) => saveDiscount({ discountValue: e.target.value })}
                style={{ width: 90 }}
              />
            </div>
            <p className="field-label" style={{ marginTop: 8 }}>รวม {fmtMoney(partsSubtotal)} บาท</p>
            {discountAmt > 0 && <p className="field-label">ส่วนลด {fmtMoney(discountAmt)} บาท</p>}
            <p className="fin-card-val" style={{ margin: '4px 0 0' }}>ยอดสุทธิ {fmtMoney(grandTotal)} บาท</p>
          </div>
        )}

        <div className="row-flex no-print" style={{ marginTop: 12 }}>
          <input
            value={customPart.name}
            onChange={(e) => setCustomPart((c) => ({ ...c, name: e.target.value }))}
            placeholder="ชื่ออะไหล่"
            style={{ flex: '1 1 140px' }}
          />
          <input
            value={customPart.qty}
            onChange={(e) => setCustomPart((c) => ({ ...c, qty: e.target.value }))}
            placeholder="จำนวน"
            style={{ width: 70 }}
          />
          <input
            value={customPart.brand}
            onChange={(e) => setCustomPart((c) => ({ ...c, brand: e.target.value }))}
            placeholder="แบรนด์"
            style={{ width: 100 }}
          />
          <input
            type="number"
            value={customPart.price}
            onChange={(e) => setCustomPart((c) => ({ ...c, price: e.target.value }))}
            placeholder="ราคา"
            style={{ width: 90 }}
          />
          <button className="btn secondary small" onClick={addCustomPart}>
            + เพิ่มรายการเอง
          </button>
          {matchedModel && (
            <button className="btn secondary small" onClick={addAllFromModel}>
              + เพิ่มทั้งหมดจากรุ่นรถ
            </button>
          )}
          <button className="btn small" onClick={() => window.print()}>
            พิมพ์ใบเสนอราคา
          </button>
        </div>

        {matchedModel && partsByCategory.length > 0 && (
          <div className="no-print" style={{ marginTop: 14 }}>
            <p className="field-label">
              เลือกจากรุ่นรถ — {matchedModel.brand} {matchedModel.name}
              {matchedModel.yearRange ? ` '${matchedModel.yearRange}` : ''} (แตะเพื่อเพิ่ม/เอาออก)
            </p>
            {partsByCategory.map(({ category, items }) => (
              <div key={category} style={{ marginTop: 8 }}>
                <p className="field-label" style={{ fontWeight: 700 }}>{category}</p>
                <div className="complaint-chips">
                  {items.map((mp) => (
                    <button
                      key={mp.id}
                      className={`chip ${usedPartNames.has(mp.partName) ? 'active' : ''}`}
                      onClick={() => togglePartFromModel(mp)}
                    >
                      {mp.partName}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>เวลาที่ใช้ซ่อม (ประมาณการ)</h3>
        <div className="dhm no-print">
          <DhmBox label="วัน" value={dhm.d} onChange={(v) => setEstMinutesTotal(v * 1440 + dhm.h * 60 + dhm.m)} />
          <span className="dhm-sep">:</span>
          <DhmBox label="ชั่วโมง" value={dhm.h} onChange={(v) => setEstMinutesTotal(dhm.d * 1440 + v * 60 + dhm.m)} />
          <span className="dhm-sep">:</span>
          <DhmBox label="นาที" value={dhm.m} onChange={(v) => setEstMinutesTotal(dhm.d * 1440 + dhm.h * 60 + v)} />
        </div>
        {eta && (
          <p className="field-label" style={{ marginTop: 10 }}>
            {eta.text}
            {eta.sub ? ` — ${eta.sub}` : ''}
          </p>
        )}
      </div>

      {job.status === 'delivered' && (
        <div className="card">
          <h3>ประกัน</h3>
          {warranty ? (
            <p className={`warranty-chip ${warranty.cls}`}>{warranty.label}</p>
          ) : (
            <p className="page-sub">ยังไม่ได้ตั้งประกัน</p>
          )}
          <div className="row-flex">
            <select value={warrantyDays} onChange={(e) => setWarrantyDays(Number(e.target.value))}>
              {WARRANTY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {warrantyOptionLabel(o.value)}
                </option>
              ))}
            </select>
            <button onClick={saveWarranty} disabled={busy}>
              บันทึก
            </button>
          </div>
        </div>
      )}

      <div className="card no-print">
        <h3>ลายเซ็น</h3>
        <div className="sig-grid">
          <SignaturePad label="เจ้าหน้าที่" value={job.signatures?.inspector} onSave={(v) => saveSignature('inspector', v)} />
          <SignaturePad label="ลูกค้า" value={job.signatures?.customer} onSave={(v) => saveSignature('customer', v)} />
        </div>
      </div>

      <div className="card no-print">
        <h3>สรุปข้อความลงกลุ่มไลน์</h3>
        <pre className="line-summary-box">{lineSummaryText}</pre>
        <div className="row-flex" style={{ marginTop: 10 }}>
          <button className="btn small" onClick={copyLineSummary}>
            คัดลอกข้อความ
          </button>
          {copyStatus && <span className="page-sub">{copyStatus}</span>}
        </div>
      </div>

      <div className="card">
        <h3>ประวัติสถานะ</h3>
        <div className="timeline">
          {job.statusHistory
            .slice()
            .reverse()
            .map((h, i) => (
              <div className="timeline-item" key={i}>
                <span>{statusOf(h.status).label}</span>
                <span className="page-sub">{fmtDT(h.changedAt)}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function DhmBox({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="dhm-box">
      <button type="button" className="dhm-btn" onClick={() => onChange(value + 1)}>
        +
      </button>
      <input
        className="dhm-n"
        type="number"
        min={0}
        value={value}
        onFocus={(e) => e.target.select()}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
      />
      <button type="button" className="dhm-btn" disabled={value === 0} onClick={() => onChange(Math.max(0, value - 1))}>
        −
      </button>
      <div className="dhm-u">{label}</div>
    </div>
  );
}
