import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import {
  DECISION_KEYS,
  EST_UNITS,
  WARRANTY_OPTIONS,
  WORK_BAYS,
  estMinutes,
  estUnitDef,
  etaState,
  fmtDT,
  isDecisionPoint,
  jobInBay,
  nextStatusOf,
  prevStatusOf,
  repairCycle,
  statusOf,
  todayKey,
  warrantyOptionLabel,
  warrantyStatus,
  type Customer,
  type Job,
  type ShopConfig,
  type Vehicle,
} from '@champpower/domain';
import { db } from '../../lib/firebase/client';
import { syncBoardEntry } from '../../lib/firebase/board';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';
import { StatusLabel, StatusTrack } from '../../components/job/StatusTrack';
import { PlateBadge } from '../../components/ui/PlateBadge';

function newId() {
  return crypto.randomUUID();
}

export function JobDetailPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const jobs = useCollection<Job>('jobs');
  const vehicles = useCollection<Vehicle>('vehicles');
  const customers = useCollection<Customer>('customers');
  const config = useDocument<ShopConfig>('config', 'main');
  const technicians = config.data?.technicians || [];

  const [schedulingDate, setSchedulingDate] = useState<string | null>(null);
  const [techInput, setTechInput] = useState('');
  const [showTechInput, setShowTechInput] = useState(false);
  const [warrantyDays, setWarrantyDays] = useState<number>(0);
  const [busy, setBusy] = useState(false);

  const job = jobs.rows.find((j) => j.id === jobId);
  const vehicle = job ? vehicles.rows.find((v) => v.id === job.vehicleId) : undefined;
  const customer = job ? customers.rows.find((c) => c.id === job.customerId) : undefined;
  const activeJobs = useMemo(() => jobs.rows.filter((j) => !j.deletedAt), [jobs.rows]);

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

  async function setEst(value: number, unit: Job['estUnit']) {
    if (!job) return;
    await updateDoc(jobRef, { estValue: value, estUnit: unit });
    await syncBoardEntry({ ...job, estValue: value, estUnit: unit }, vehicle);
  }

  async function saveWarranty() {
    await updateDoc(jobRef, { warrantyDays });
  }

  const next = nextStatusOf(job);
  const prev = prevStatusOf(job);
  const atDecision = isDecisionPoint(job.status);
  const cycle = repairCycle(job);
  const eta = etaState(estMinutes(job), cycle.start, cycle.end);
  const warranty = warrantyStatus(job);

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
        </p>

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
        <h3>เวลาที่ใช้ซ่อม (ประมาณการ)</h3>
        <div className="row-flex no-print">
          <input
            type="number"
            min={0}
            defaultValue={Number(job.estValue) || ''}
            onBlur={(e) => setEst(Number(e.target.value) || 0, job.estUnit || 'hour')}
            style={{ width: 90 }}
          />
          <select
            defaultValue={job.estUnit || 'hour'}
            onChange={(e) => setEst(Number(job.estValue) || 0, e.target.value as Job['estUnit'])}
          >
            {EST_UNITS.map((u) => (
              <option key={u.key} value={u.key}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
        {eta && (
          <p className="field-label" style={{ marginTop: 10 }}>
            {eta.text}
            {eta.sub ? ` — ${eta.sub}` : ''}
          </p>
        )}
        {!eta && job.estValue ? (
          <p className="field-label" style={{ marginTop: 10 }}>
            ประมาณ {Number(job.estValue)} {estUnitDef(job.estUnit).label}
          </p>
        ) : null}
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
