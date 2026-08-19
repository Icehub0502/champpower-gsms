import { useState } from 'react';
import {
  ALIGN_BAY,
  DECISION_KEYS,
  WORK_BAYS,
  fmtDT,
  isDecisionPoint,
  jobInBay,
  MAIN_PATH,
  nextStatusOf,
  prevStatusOf,
  statusOf,
  STATUS_FLOW,
  type Customer,
  type Job,
  type StatusKey,
  type Vehicle,
} from '@champpower/domain';
import { PlateBadge } from '../ui/PlateBadge';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';

type Picker = 'bay' | 'tech' | 'status' | null;

interface JobCardProps {
  job: Job;
  vehicle: Vehicle | undefined;
  customer: Customer | undefined;
  activeJobs: Job[];
  technicians: string[];
  selMode: boolean;
  selected: boolean;
  canDelete: boolean;
  onOpen: (jobId: string) => void;
  onToggleSelect: (jobId: string) => void;
  onSetStatus: (jobId: string, status: StatusKey) => void;
  onAssignBay: (jobId: string, bay: string) => void;
  onAssignTechnician: (jobId: string, name: string) => void;
  onDelete: (jobId: string) => void;
}

export function JobCard({
  job,
  vehicle,
  customer,
  activeJobs,
  technicians,
  selMode,
  selected,
  canDelete,
  onOpen,
  onToggleSelect,
  onSetStatus,
  onAssignBay,
  onAssignTechnician,
  onDelete,
}: JobCardProps) {
  const [picker, setPicker] = useState<Picker>(null);
  const [techInput, setTechInput] = useState('');

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

  return (
    <div className={`job-card ${st.cls} ${selMode ? 'select-mode' : ''} ${selected ? 'selected' : ''}`}>
      <div
        className="jc-main"
        onClick={() => (selMode ? onToggleSelect(job.id) : onOpen(job.id))}
      >
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
            return (
              <button
                key={bay}
                className={`chip ${job.bay === bay ? 'active' : ''}`}
                disabled={!!occ}
                title={occ ? 'มีงานอื่นจอดอยู่' : 'ว่าง'}
                onClick={() => {
                  onAssignBay(job.id, job.bay === bay ? '' : bay);
                  setPicker(null);
                }}
              >
                {bay}
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
        </Modal>
      )}

      {picker === 'status' && (
        <Modal title="เปลี่ยนสถานะ" onClose={() => setPicker(null)}>
          {STATUS_FLOW.map((s) => (
            <button
              key={s.key}
              className={`chip ${job.status === s.key ? 'active' : ''}`}
              onClick={() => {
                onSetStatus(job.id, s.key);
                setPicker(null);
              }}
            >
              {s.label}
            </button>
          ))}
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
