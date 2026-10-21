import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Role, TodayResponse } from '@gsms/contracts/index.js';
import { PlateBadge } from '../../components/ui/PlateBadge';
import { useDocument } from '../../hooks/useDocument';
import { StockNav } from './StockNav';
import { ISSUABLE_JOB_STATUSES, stockRoutes } from './stockLabels';

/**
 * เบิกของ — pick the job. Office stands at the store room with a pile of parts and needs the
 * car, not a menu: every car still in the workshop whose quotation is confirmed (approved
 * up to ready), filterable by plate / job number / customer. A job that has left the board
 * (delivered, closed) is reached from ของจองค้าง instead.
 */
export function IssuePickJobPage({ role }: { role: Role | null }) {
  const board = useDocument<TodayResponse>('/api/jobs/today', 'job:changed');
  const [q, setQ] = useState('');
  const qId = useId();
  const needle = q.trim().toLowerCase();
  const jobs = (board.data?.jobs ?? [])
    .filter((j) => (ISSUABLE_JOB_STATUSES as readonly string[]).includes(j.status))
    .filter((j) => needle === '' || [j.jobNumber, j.plate, j.customerName, j.brand, j.model].some((v) => v?.toLowerCase().includes(needle)));

  return (
    <div className="qt-page st-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>เบิกของ</h1>
          <p className="page-sub">เลือกรถที่จะเบิกอะไหล่ให้ — เฉพาะงานที่ลูกค้ายืนยันใบเสนอราคาแล้วและยังอยู่ในอู่</p>
        </div>
      </header>
      <StockNav role={role} />

      <section className="card st-filters" aria-label="ค้นหางาน">
        <label className="field ci-field" htmlFor={qId}>
          <span className="ci-field-label">ค้นหา ทะเบียน / เลขงาน / ลูกค้า</span>
          <input id={qId} type="search" value={q} autoComplete="off" autoFocus onChange={(e) => setQ(e.target.value)} />
        </label>
      </section>

      {board.loading && !board.data && <div className="page-loading">กำลังโหลด...</div>}
      {board.error && !board.data && (
        <div className="empty-state" role="alert">
          โหลดรายการงานไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => board.reload?.()}>ลองใหม่</button></div>
        </div>
      )}
      {board.data && jobs.length === 0 && (
        <div className="empty-state">{needle ? 'ไม่พบงานที่ตรงกับคำค้น' : 'ยังไม่มีงานที่ยืนยันใบเสนอราคาแล้วในอู่ตอนนี้'}</div>
      )}
      {jobs.length > 0 && (
        <ul className="st-job-pick">
          {jobs.map((j) => (
            <li key={j.jobId}>
              <Link className="card st-job-card" to={stockRoutes.jobIssue(j.jobId)}>
                <span className="st-row-main">
                  <strong className="mono">{j.jobNumber}</strong>
                  <span>{[j.brand, j.model].filter(Boolean).join(' ') || 'ไม่ระบุรุ่น'}{j.customerName ? ` · ${j.customerName}` : ''}</span>
                  <span className="qt-line-sub">{j.statusLabel}{j.bayName ? ` · ${j.bayName}` : ''}</span>
                </span>
                {j.plate && <PlateBadge plate={j.plate} size="sm" />}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
