import type { TodayPulse } from '@gsms/contracts/index.js';

/**
 * "ภาพรวมพื้นที่ทำงาน" — the 4 tiles under the board (figma-80 brief). Every
 * number here comes from pulseOf() in packages/domain, computed server-side
 * from the same rows the columns and KPIs use, so this panel can never
 * disagree with what is actually on the board above it.
 */
export function PulsePanel({ pulse }: { pulse: TodayPulse }) {
  return (
    <section className="kb-pulse card">
      <h3>ภาพรวมพื้นที่ทำงาน</h3>
      <div className="kb-pulse-grid">
        <div className="kb-pulse-tile">
          <span className="kb-pulse-label">ช่องซ่อมที่ใช้งาน</span>
          <span className="kb-pulse-value tone-blue">{pulse.baysInUse} / {pulse.baysActive} ช่อง</span>
        </div>
        <div className="kb-pulse-tile">
          <span className="kb-pulse-label">เวลารอตรวจเฉลี่ย</span>
          <span className="kb-pulse-value tone-wait">
            {pulse.avgInspectionWaitMinutes === null ? '—' : `${pulse.avgInspectionWaitMinutes} นาที`}
          </span>
        </div>
        <div className="kb-pulse-tile">
          <span className="kb-pulse-label">งานรออะไหล่</span>
          <span className="kb-pulse-value tone-parts">{pulse.waitingParts} งาน</span>
        </div>
        <div className="kb-pulse-tile">
          <span className="kb-pulse-label">งานเกิน SLA</span>
          <span className="kb-pulse-value tone-red">
            {pulse.overSla} งาน{pulse.overSla > 0 ? ' • ต้องติดตาม' : ''}
          </span>
        </div>
      </div>
    </section>
  );
}
