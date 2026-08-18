import { dayLabel, shiftDay, todayKey } from '@champpower/domain';

interface DayNavigatorProps {
  dayFilter: string; // a date key, or 'all'
  onChange: (key: string) => void;
}

export function DayNavigator({ dayFilter, onChange }: DayNavigatorProps) {
  const isAll = dayFilter === 'all';
  const current = isAll ? todayKey() : dayFilter;

  return (
    <div className="day-nav">
      <button className="day-nav-arrow" onClick={() => onChange(shiftDay(current, -1))} aria-label="วันก่อนหน้า">
        ‹
      </button>
      <button className={`day-chip ${current === todayKey() && !isAll ? 'active' : ''}`} onClick={() => onChange(todayKey())}>
        วันนี้
      </button>
      <span className="day-nav-label">{isAll ? 'ทุกวัน' : dayLabel(current)}</span>
      <button className={`day-chip ${isAll ? 'active' : ''}`} onClick={() => onChange('all')}>
        ทุกวัน
      </button>
      <button className="day-nav-arrow" onClick={() => onChange(shiftDay(current, 1))} aria-label="วันถัดไป">
        ›
      </button>
    </div>
  );
}
