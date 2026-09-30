import type { TodayKpis } from '@gsms/contracts/index.js';

const TILES: { key: keyof TodayKpis; label: string; tone: 'red' | 'orange' | 'blue' | 'green' }[] = [
  { key: 'openJobs', label: 'งานเปิดทั้งหมด', tone: 'red' },
  { key: 'awaitingDecision', label: 'รอลูกค้าตัดสินใจ', tone: 'orange' },
  { key: 'inRepair', label: 'ซ่อม / ตั้งศูนย์', tone: 'blue' },
  { key: 'readyForHandover', label: 'พร้อมส่ง / รอชำระ', tone: 'green' },
];

/** The 4 headline tiles (figma-80 brief). Counted by kpisOf() in
 * packages/domain, server-side — this renders numbers, it does not count. */
export function KpiRow({ kpis }: { kpis: TodayKpis }) {
  return (
    <div className="kb-kpi-grid">
      {TILES.map((t) => (
        <div key={t.key} className={`kb-kpi tone-${t.tone}`}>
          <span className="kb-kpi-value">{kpis[t.key]}</span>
          <span className="kb-kpi-label">{t.label}</span>
        </div>
      ))}
    </div>
  );
}
