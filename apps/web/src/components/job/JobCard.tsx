import { useState } from 'react';
import {
  ALIGN_BAY,
  DECISION_KEYS,
  WORK_BAYS,
  dayLabel,
  fmtDT,
  isDecisionPoint,
  jobInBay,
  MAIN_PATH,
  nextStatusOf,
  prevStatusOf,
  statusOf,
  STATUS_FLOW,
  todayKey,
  type Customer,
  type Job,
  type StatusKey,
  type Vehicle,
} from '@champpower/domain';
import { PlateBadge } from '../ui/PlateBadge';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';

type Picker = 'bay' | 'tech' | 'status' | 'edit' | null;

interface JobCardProps {
  job: Job;
  vehicle: Vehicle | undefined;
  customer: Customer | undefined;
  activeJobs: Job[];
  vehicleById: Map<string, Vehicle>;
  technicians: string[];
  selMode: boolean;
  selected: boolean;
  canDelete: boolean;
  canManageTechnicians: boolean;
  onOpen: (jobId: string) => void;
  onToggleSelect: (jobId: string) => void;
  onSetStatus: (jobId: string, status: StatusKey) => void;
  onSchedule: (jobId: string, appointmentDate: string) => void;
  onAssignBay: (jobId: string, bay: string) => void;
  onAssignTechnician: (jobId: string, name: string) => void;
  onDelete: (jobId: string) => void;
  onEditInfo: (
    vehicleId: string,
    customerId: string,
    vehiclePatch: Partial<Vehicle>,
    customerPatch: Partial<Customer>,
  ) => void;
}

/** Appointment chips warn when the date is today or already past. */
function apptClass(date: string): string {
  const today = todayKey();
  if (date === today) return 'today';
  return date < today ? 'overdue' : '';
}

export function JobCard({
  job,
  vehicle,
  customer,
  activeJobs,
  vehicleById,
  technicians,
  selMode,
  selected,
  canDelete,
  canManageTechnicians,
  onOpen,
  onToggleSelect,
  onSetStatus,
  onSchedule,
  onAssignBay,
  onAssignTechnician,
  onDelete,
  onEditInfo,
}: JobCardProps) {
  const [picker, setPicker] = useState<Picker>(null);
  const [techInput, setTechInput] = useState('');
  // null = the status modal is not currently asking for an appointment date.
  const [schedulingDate, setSchedulingDate] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    plate: '',
    province: '',
    brand: '',
    model: '',
    color: '',
    customerName: '',
    customerPhone: '',
  });

  function openEditForm(e: React.MouseEvent) {
    stop(e);
    setEditForm({
      plate: vehicle?.plate || '',
      province: vehicle?.province || '',
      brand: vehicle?.brand || '',
      model: vehicle?.model || '',
      color: vehicle?.color || '',
      customerName: customer?.name || '',
      customerPhone: customer?.phone || '',
    });
    setPicker('edit');
  }

  function saveEditForm() {
    onEditInfo(
      job.vehicleId,
      job.customerId,
      {
        plate: editForm.plate.trim().toUpperCase(),
        province: editForm.province.trim(),
        brand: editForm.brand.trim().toUpperCase(),
        model: editForm.model.trim().toUpperCase(),
        color: editForm.color.trim(),
      },
      {
        name: editForm.customerName.trim(),
        phone: editForm.customerPhone.trim(),
      },
    );
    setPicker(null);
  }

  const st = statusOf(job.status);
  const nextSt = nextStatusOf(job);
  const prevSt = prevStatusOf(job);
  const atDecision = isDecisionPoint(job.status);

  function stop(e: React.MouseEvent) {
    e.stopPropagation();
  }

  function openPicker(which: Picker, e: React.MouseEvent) {
    stop(e);
    setPicker(which);
  }

  function closeStatusPicker() {
    setPicker(null);
    setSchedulingDate(null);
  }

  function confirmSchedule() {
    if (!schedulingDate) return;
    onSchedule(job.id, schedulingDate);
    closeStatusPicker();
  }

  return (
    <div className={`job-card ${st.cls} ${selMode ? 'select-mode' : ''} ${selected ? 'selected' : ''}`}>
      <div
        className="jc-main"
        onClick={() => (selMode ? onToggleSelect(job.id) : onOpen(job.id))}
      >
        {selMode && (
          <span className={`jc-check ${selected ? 'on' : ''}`} aria-hidden="true">
            {selected && <Icon name="check" size={14} />}
          </span>
        )}
        <div className="jc-idblock">
          {job.thumb ? (
            <img className="jc-thumb" src={job.thumb} alt="" />
          ) : (
            <div className="jc-thumb jc-thumb-empty">
              <Icon name="camera" size={22} />
            </div>
          )}
          <PlateBadge plate={vehicle?.plate} province={vehicle?.province} size="fit" />
        </div>
        <div className="jc-left">
          <div className="jc-tags">
            {job.queueNo && <span className="jc-queue">คิว {job.queueNo}</span>}
            {job.appointmentDate && (
              <span className={`jc-appt ${apptClass(job.appointmentDate)}`}>
                <Icon name="calendar" size={11} /> {dayLabel(job.appointmentDate)}
              </span>
            )}
            {job.bay ? (
              <span className={`bay-chip ${job.bay === ALIGN_BAY ? 'align' : ''}`}>
                {job.bay}
                {job.technician ? ` • ${job.technician}` : ''}
              </span>
            ) : job.technician ? (
              <span className="bay-chip">
                <Icon name="wrench" size={10} /> {job.technician}
              </span>
            ) : null}
          </div>
          <div className="meta strong">
            {vehicle?.brand || ''} {vehicle?.model || ''}
            {vehicle?.color ? ` · ${vehicle.color}` : ''}
          </div>
          <div className="meta">{customer?.name || '-'}</div>
          <div className="jn mono">
            {job.jobNumber} · {fmtDT(job.createdAt)}
          </div>
        </div>
        <span className={`badge ${st.cls}`}>{st.label}</span>
      </div>

      {!selMode && (
        <div className="jc-actions">
          <div className="jc-steps" title={st.label}>
            <StatusSegs job={job} />
          </div>
          <button className="btn secondary small" onClick={(e) => openPicker('bay', e)}>
            {job.bay || 'เลือกช่อง'}
          </button>
          <button className="btn secondary small" onClick={(e) => openPicker('tech', e)}>
            <Icon name="wrench" size={13} /> {job.technician || 'มอบหมายช่าง'}
          </button>
          <button className="btn secondary small" onClick={(e) => openPicker('status', e)}>
            สถานะ
          </button>
          <button className="btn secondary small" onClick={openEditForm}>
            <Icon name="edit" size={13} /> แก้ไขข้อมูล
          </button>

          {!atDecision && (prevSt || nextSt) && (
            <div className="jc-steprow">
              {prevSt && (
                <button
                  className="btn back-step small"
                  onClick={(e) => {
                    stop(e);
                    onSetStatus(job.id, prevSt.key);
                  }}
                >
                  <Icon name="back" size={12} /> {prevSt.label}
                </button>
              )}
              {nextSt && (
                <button
                  className="btn hazard small"
                  onClick={(e) => {
                    stop(e);
                    onSetStatus(job.id, nextSt.key);
                  }}
                >
                  {nextSt.label} <Icon name="forward" size={12} />
                </button>
              )}
            </div>
          )}

          {canDelete && (
            <button
              className="jc-del"
              title="ลบรายการนี้"
              aria-label="ลบรายการนี้"
              onClick={(e) => {
                stop(e);
                onDelete(job.id);
              }}
            >
              <Icon name="trash" size={15} />
            </button>
          )}

        </div>
      )}

      {picker === 'bay' && (
        <Modal title="เลือกช่องจอด" onClose={() => setPicker(null)}>
          {WORK_BAYS.map((bay) => {
            const occ = jobInBay(activeJobs, bay, job.id);
            // A `title` tooltip never surfaces on touch devices (shop staff use tablets),
            // so the occupant is rendered as visible text on the disabled button instead.
            const occVehicleId = occ ? activeJobs.find((j) => j.id === occ.id)?.vehicleId : undefined;
            const occPlate = occVehicleId ? vehicleById.get(occVehicleId)?.plate : '';
            return (
              <button
                key={bay}
                className={`chip bay-opt ${job.bay === bay ? 'active' : ''}`}
                disabled={!!occ}
                title={occ ? 'มีงานอื่นจอดอยู่' : 'ว่าง'}
                onClick={() => {
                  onAssignBay(job.id, job.bay === bay ? '' : bay);
                  setPicker(null);
                }}
              >
                {bay}
                {occ && <span className="bay-opt-occ">{occPlate ? `ไม่ว่าง · ${occPlate}` : 'ไม่ว่าง'}</span>}
              </button>
            );
          })}
        </Modal>
      )}

      {picker === 'tech' && (
        <Modal title="มอบหมายช่าง" onClose={() => setPicker(null)}>
          {technicians.map((name) => (
            <button
              key={name}
              className={`chip ${job.technician === name ? 'active' : ''}`}
              onClick={() => {
                onAssignTechnician(job.id, name);
                setPicker(null);
              }}
            >
              {name}
            </button>
          ))}
          {canManageTechnicians && (
            <div className="row-flex" style={{ width: '100%', marginTop: 4 }}>
              <input
                value={techInput}
                onChange={(e) => setTechInput(e.target.value)}
                placeholder="ชื่อช่างใหม่"
                style={{ flex: '1 1 140px' }}
              />
              <button
                className="btn small"
                onClick={() => {
                  if (techInput.trim()) {
                    onAssignTechnician(job.id, techInput.trim());
                    setTechInput('');
                    setPicker(null);
                  }
                }}
              >
                บันทึก
              </button>
            </div>
          )}
        </Modal>
      )}

      {picker === 'status' && (
        <Modal title="เปลี่ยนสถานะ" onClose={closeStatusPicker}>
          {STATUS_FLOW.map((s) => (
            <button
              key={s.key}
              className={`chip ${job.status === s.key ? 'active' : ''}`}
              onClick={() => {
                // "นัดวันมาทำ" must never be set without an appointment date — this is the
                // same two-step confirm the job-detail decision row already uses.
                if (s.key === 'scheduled') {
                  setSchedulingDate(job.appointmentDate || todayKey());
                  return;
                }
                onSetStatus(job.id, s.key);
                closeStatusPicker();
              }}
            >
              {s.label}
            </button>
          ))}
          {schedulingDate !== null && (
            <div className="row-flex" style={{ width: '100%', marginTop: 8 }}>
              <input
                type="date"
                value={schedulingDate}
                onChange={(e) => setSchedulingDate(e.target.value)}
                style={{ flex: '1 1 140px' }}
              />
              <button className="btn small" onClick={confirmSchedule} disabled={!schedulingDate}>
                ยืนยันวันนัด
              </button>
            </div>
          )}
        </Modal>
      )}

      {picker === 'edit' && (
        <Modal title="แก้ไขข้อมูล" onClose={() => setPicker(null)}>
          <div className="edit-form" onClick={stop}>
            <label className="field">
              ทะเบียนรถ
              <input
                value={editForm.plate}
                onChange={(e) => setEditForm((f) => ({ ...f, plate: e.target.value }))}
              />
            </label>
            <label className="field">
              จังหวัด
              <input
                value={editForm.province}
                onChange={(e) => setEditForm((f) => ({ ...f, province: e.target.value }))}
              />
            </label>
            <label className="field">
              ยี่ห้อ
              <input
                value={editForm.brand}
                onChange={(e) => setEditForm((f) => ({ ...f, brand: e.target.value }))}
              />
            </label>
            <label className="field">
              รุ่น
              <input
                value={editForm.model}
                onChange={(e) => setEditForm((f) => ({ ...f, model: e.target.value }))}
              />
            </label>
            <label className="field">
              สี
              <input
                value={editForm.color}
                onChange={(e) => setEditForm((f) => ({ ...f, color: e.target.value }))}
              />
            </label>
            <label className="field">
              ชื่อลูกค้า
              <input
                value={editForm.customerName}
                onChange={(e) => setEditForm((f) => ({ ...f, customerName: e.target.value }))}
              />
            </label>
            <label className="field">
              เบอร์โทร
              <input
                value={editForm.customerPhone}
                onChange={(e) => setEditForm((f) => ({ ...f, customerPhone: e.target.value }))}
              />
            </label>
            <button className="btn block" onClick={saveEditForm}>
              บันทึกการแก้ไข
            </button>
          </div>
        </Modal>
      )}

      {!selMode && atDecision && (
        <div className="jc-decide">
          <span className="jd-label">ลูกค้าตอบว่า</span>
          <div className="jd-btns">
            {DECISION_KEYS.map((key) => {
              const d = statusOf(key);
              return (
                <button
                  key={key}
                  className={`btn small decide ${d.cls}`}
                  onClick={(e) => {
                    stop(e);
                    if (key === 'scheduled') {
                      setSchedulingDate(job.appointmentDate || todayKey());
                      setPicker('status');
                      return;
                    }
                    onSetStatus(job.id, key);
                  }}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusSegs({ job }: { job: Job }) {
  let path: string[];
  if (job.status === 'scheduled' || job.status === 'rejected') {
    path = ['received', 'inspecting', 'quoted', job.status, 'carout'];
  } else if (job.status === 'carout') {
    path = ['received', 'inspecting', 'quoted', '—', 'carout'];
  } else {
    path = MAIN_PATH;
  }
  const idx = path.indexOf(job.status);
  return (
    <>
      {path.map((k, i) => {
        const s = STATUS_FLOW.find((x) => x.key === k);
        const done = idx > -1 && i <= idx;
        return (
          <span
            key={i}
            className={`jc-seg ${done ? `done ${s ? s.cls : ''}` : ''} ${i === idx ? 'now' : ''}`}
          />
        );
      })}
    </>
  );
}
