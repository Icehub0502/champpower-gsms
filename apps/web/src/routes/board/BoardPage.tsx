import { useEffect, useRef, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { WORK_BAYS, dayKey, todayKey } from '@champpower/domain';
import { db } from '../../lib/firebase/client';
import { PlateBadge } from '../../components/ui/PlateBadge';
import { StatusLabel } from '../../components/job/StatusTrack';

interface BoardRow {
  id: string;
  queueNo: string;
  plate: string;
  province: string;
  brand: string;
  model: string;
  color: string;
  bay: string;
  est: string;
  status: string;
  statusLabel: string;
  statusCls: string;
  createdAt: string;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Public, no-login waiting-room display. Reads only /board, which the app takes care
 * never to write name/phone/price into (see boardPayloadFor in @champpower/domain).
 * Today-only, same rule as the job list — an unbounded board is unreadable by the
 * afternoon.
 */
const FADE_OUT_MS = 900;

export function BoardPage() {
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());
  const goneIdsRef = useRef<Set<string>>(new Set());
  const now = useClock();

  useEffect(() => {
    return onSnapshot(collection(db, 'board'), (snap) => {
      setRows(snap.docs.map((d) => ({ ...(d.data() as Omit<BoardRow, 'id'>), id: d.id })));
    });
  }, []);

  // A job hitting "delivered" would otherwise vanish from the list the instant the
  // next snapshot lands. Instead, mark it as fading and keep rendering it (still
  // filtered out of the normal query below) for one animation's worth of time, then
  // drop it for good so it doesn't reappear if the row is re-rendered afterward.
  useEffect(() => {
    const deliveredToday = rows.filter(
      (r) => r.status === 'delivered' && dayKey(r.createdAt) === todayKey(),
    );
    deliveredToday.forEach((r) => {
      if (goneIdsRef.current.has(r.id)) return;
      setFadingIds((prev) => (prev.has(r.id) ? prev : new Set(prev).add(r.id)));
      setTimeout(() => {
        goneIdsRef.current.add(r.id);
        setFadingIds((prev) => {
          if (!prev.has(r.id)) return prev;
          const next = new Set(prev);
          next.delete(r.id);
          return next;
        });
      }, FADE_OUT_MS);
    });
  }, [rows]);

  // Kiosk display, nobody's holding a mouse — auto-scroll down a screenful every 3s
  // so a long queue is readable without anyone touching the screen, looping back to
  // the top once it reaches the bottom. Smooth-scrolls so it's a glide, not a jump.
  useEffect(() => {
    const id = setInterval(() => {
      const el = document.scrollingElement || document.documentElement;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      if (atBottom) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        window.scrollBy({ top: el.clientHeight * 0.85, behavior: 'smooth' });
      }
    }, 3000);
    return () => clearInterval(id);
  }, []);

  const todayRows = rows
    .filter((r) => dayKey(r.createdAt) === todayKey())
    .filter((r) => r.status !== 'delivered' || fadingIds.has(r.id))
    .sort((a, b) => {
      const qa = parseInt(a.queueNo, 10);
      const qb = parseInt(b.queueNo, 10);
      if (Number.isFinite(qa) && Number.isFinite(qb) && qa !== qb) return qa - qb;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  const bayOf = (bay: string) => todayRows.find((r) => r.bay === bay);

  return (
    <div className="board-page">
      <header className="board-header">
        <span className="board-title">POWER GROUP</span>
        <span className="board-clock">{now.toLocaleTimeString('th-TH')}</span>
      </header>

      <div className="board-bays">
        {WORK_BAYS.map((bay) => {
          const occupant = bayOf(bay);
          return (
            <div className={`board-bay ${occupant ? 'occupied' : ''}`} key={bay}>
              <div className="board-bay-label">{bay}</div>
              {occupant ? <div className="board-bay-plate">{occupant.plate}</div> : <div className="board-bay-empty">ว่าง</div>}
            </div>
          );
        })}
      </div>

      {todayRows.length === 0 ? (
        <div className="empty-state">ยังไม่มีรถวันนี้</div>
      ) : (
        <div className="board-rows">
          {todayRows.map((r) => (
            <div className={`board-row ${fadingIds.has(r.id) ? 'board-row-fading' : ''}`} key={r.id}>
              <div className="board-row-queue">
                {r.queueNo ? (
                  <span className="board-row-queue-n">{r.queueNo}</span>
                ) : (
                  <span className="board-row-queue-dash">—</span>
                )}
              </div>
              <PlateBadge plate={r.plate} province={r.province} size="lg" />
              <div className="board-row-model">
                {r.brand} {r.model} {r.color && `· ${r.color}`}
              </div>
              <div className="board-row-bay">{r.bay || '-'}</div>
              {r.est && <div className="board-row-est">{r.est}</div>}
              <StatusLabel status={r.status as never} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
