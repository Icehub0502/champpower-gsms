import { Fragment, useState } from 'react';
import { Icon } from '../../components/ui/Icon';

// TODO: replace mock data with real Firestore query once backend exists (an
// "appointments" collection keyed by job/vehicle + scheduled datetime).
interface MockAppointment {
  id: string;
  day: number; // 0 = Monday .. 6 = Sunday, matches DAYS below
  hour: number; // 9..16
  title: string;
  sub: string;
  tone: 'red' | 'info' | 'success' | 'warning';
}

const DAYS = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];
const DATES = [24, 25, 26, 27, 28, 29, 30];
const HOURS = [9, 10, 11, 12, 13, 14, 15, 16];
const TODAY_INDEX = 1; // ux note: highlights "25 ส.ค." as today for this mock week

const MOCK_APPOINTMENTS: MockAppointment[] = [
  { id: 'a1', day: 0, hour: 9, title: 'TOYOTA CAMRY', sub: 'เช็กแร็คพวงมาลัย', tone: 'red' },
  { id: 'a2', day: 0, hour: 10, title: 'BMW F30', sub: 'เปลี่ยนปีกนกหน้า', tone: 'info' },
  { id: 'a3', day: 2, hour: 13, title: 'HONDA CR-V', sub: 'ตรวจช่วงล่าง', tone: 'success' },
  { id: 'a4', day: 3, hour: 15, title: 'BENZ W205', sub: 'พวงมาลัยมีเสียง', tone: 'warning' },
];

export function CalendarPage() {
  const [view, setView] = useState<'day' | 'week' | 'month'>('week');

  return (
    <div className="page">
      <h1>ปฏิทินนัดหมาย</h1>
      <p className="page-sub">ภาพรวมนัดหมายลูกค้าที่จะกลับมาซ่อม/รับรถ (ข้อมูลตัวอย่าง)</p>

      <div className="cal-toolbar">
        <div className="cal-view-toggle">
          <button type="button" className={view === 'day' ? 'active' : ''} onClick={() => setView('day')}>
            วันนี้
          </button>
          <button type="button" className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>
            สัปดาห์
          </button>
          <button type="button" className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>
            เดือน
          </button>
        </div>
        <span className="cal-range-label">24–30 สิงหาคม 2026</span>
        <button type="button" className="btn small" style={{ marginLeft: 'auto' }}>
          <Icon name="plus" size={14} /> เพิ่มนัดหมาย
        </button>
      </div>

      <div className="cal-grid-wrap">
        <div className="cal-grid">
          <div className="cal-head-cell" />
          {DAYS.map((d, i) => (
            <div key={d} className={`cal-head-cell${i === TODAY_INDEX ? ' today' : ''}`}>
              {d} {DATES[i]}
            </div>
          ))}

          {HOURS.map((h) => (
            <Fragment key={h}>
              <div className="cal-time-cell">{String(h).padStart(2, '0')}:00</div>
              {DAYS.map((_, dayIdx) => {
                const items = MOCK_APPOINTMENTS.filter((a) => a.day === dayIdx && a.hour === h);
                return (
                  <div key={`${h}-${dayIdx}`} className="cal-cell">
                    {items.map((a) => (
                      <div key={a.id} className={`cal-appt ${a.tone === 'red' ? '' : a.tone}`}>
                        <div>{a.title}</div>
                        <div>{a.sub}</div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
