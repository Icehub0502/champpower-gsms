import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { STATUS_FLOW } from '@champpower/domain';
import type { PublicBoardCar, PublicBoardResponse } from '@gsms/contracts/index.js';
import { useBoardFeed } from './useBoardFeed';
import { PlateBadge } from '../../components/ui/PlateBadge';

/**
 * The waiting-room television — /board/:token, NO login (docs/UI-SPEC-FIGMA.md
 * §2 "จอ A", §4 "จอสาธารณะ /board").
 *
 * What this page must never do, and how it is kept from doing it:
 *   - Show a name, phone, price or photo. The response type
 *     (packages/contracts/src/publicBoard.ts) has no such field, and this page
 *     has no element that could render one — there is no <img> here at all.
 *   - Send a staff session. It calls publicApi, which never attaches
 *     Authorization even when a staff token sits in memory in the same browser.
 *   - Guess a shop. The shop is named only by the unguessable token in the
 *     URL; plain /board says it needs the owner's link and requests nothing.
 *   - Filter by date. Today's delivered cars arrive flagged `deliveredToday`
 *     and are dimmed; the API drops them the next day. The client does not
 *     decide what "today" is.
 *
 * Updates are by polling only: the public socket room is joined by shop slug,
 * which this page does not have and must not be given.
 */

/** Its own component so the once-a-second tick re-renders only the clock, not the board. */
function BoardClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="board-clock">{now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</span>;
}

function statusCls(status: string): string {
  return STATUS_FLOW.find((s) => s.key === status)?.cls ?? '';
}

/** Queue order, cars without a number after, today's delivered cars last. */
function byBoardOrder(a: PublicBoardCar, b: PublicBoardCar): number {
  if (a.deliveredToday !== b.deliveredToday) return a.deliveredToday ? 1 : -1;
  const qa = a.queueNo ?? Number.POSITIVE_INFINITY;
  const qb = b.queueNo ?? Number.POSITIVE_INFINITY;
  if (qa !== qb) return qa - qb;
  return Date.parse(a.statusChangedAt) - Date.parse(b.statusChangedAt);
}

function Board({ data }: { data: PublicBoardResponse }) {
  const cars = [...data.cars].sort(byBoardOrder);
  const inWorkshop = cars.filter((c) => !c.deliveredToday);

  return (
    <>
      <div className="board-bays">
        {data.bays.map((bay) => {
          const occupant = inWorkshop.find((c) => c.bayName === bay.name);
          const occupied = bay.inUse || Boolean(occupant);
          return (
            <div className={`board-bay${occupied ? ' occupied' : ''}`} key={bay.name}>
              <div className="board-bay-label">{bay.name}</div>
              {occupant ? (
                <div className="board-bay-plate">{occupant.plate}</div>
              ) : (
                <div className="board-bay-empty">{occupied ? 'ไม่ว่าง' : 'ว่าง'}</div>
              )}
            </div>
          );
        })}
      </div>

      {cars.length === 0 ? (
        <p className="board-message">ยังไม่มีรถวันนี้</p>
      ) : (
        <div className="board-rows">
          {cars.map((c) => (
            <div
              className={`board-row${c.deliveredToday ? ' is-delivered' : ''}`}
              key={`${c.plate}|${c.queueNo ?? ''}|${c.deliveredToday ? 'd' : 'o'}`}
            >
              <div className="board-row-queue">
                {c.queueNo !== null ? (
                  <span className="board-row-queue-n">{c.queueNo}</span>
                ) : (
                  <span className="board-row-queue-dash" aria-label="ไม่มีเลขคิว">—</span>
                )}
              </div>
              <PlateBadge plate={c.plate} province={c.province ?? undefined} size="lg" />
              <div className="board-row-model">
                {c.brand} {c.model}
                {c.color && ` · ${c.color}`}
              </div>
              {c.bayName && !c.deliveredToday && <div className="board-row-bay">ช่อง {c.bayName}</div>}
              {c.estLabel && !c.deliveredToday && <div className="board-row-est">ใช้เวลาประมาณ {c.estLabel}</div>}
              {/* The status is always its words — the chip colour only repeats it. */}
              <span className={`status-chip ${statusCls(c.status)}`}>{c.statusLabel}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function BoardPage() {
  const { token } = useParams<{ token?: string }>();
  const feed = useBoardFeed(token);

  // Kiosk display, nobody's holding a mouse — glide down a screenful every
  // few seconds so a long queue is readable untouched, looping to the top.
  useEffect(() => {
    const id = window.setInterval(() => {
      const el = document.scrollingElement || document.documentElement;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      if (atBottom) window.scrollTo({ top: 0, behavior: 'smooth' });
      else window.scrollBy({ top: el.clientHeight * 0.85, behavior: 'smooth' });
    }, 6000);
    return () => window.clearInterval(id);
  }, []);

  const data = feed.kind === 'ok' || feed.kind === 'error' ? feed.data : null;

  let body;
  if (!token) {
    body = (
      <p className="board-message" role="status">
        จอนี้ต้องเปิดจากลิงก์กระดานของร้าน
        <small>ขอลิงก์จากเจ้าของร้านหรือผู้จัดการ</small>
      </p>
    );
  } else if (feed.kind === 'not_found') {
    body = (
      <p className="board-message" role="alert">
        ลิงก์กระดานนี้ใช้ไม่ได้
        <small>ลิงก์อาจถูกเปลี่ยนใหม่ — ขอลิงก์ล่าสุดจากเจ้าของร้าน</small>
      </p>
    );
  } else if (data) {
    body = (
      <>
        {feed.kind === 'error' && (
          <p className="board-stale" role="status">
            เชื่อมต่อไม่ได้ชั่วคราว — กำลังลองใหม่ ข้อมูลนี้อาจไม่ใช่ล่าสุด
          </p>
        )}
        <Board data={data} />
      </>
    );
  } else if (feed.kind === 'error') {
    body = (
      <p className="board-message" role="status">
        เชื่อมต่อไม่ได้ชั่วคราว
        <small>กำลังลองใหม่อัตโนมัติ</small>
      </p>
    );
  } else {
    body = <p className="board-message" role="status">กำลังโหลด…</p>;
  }

  return (
    <div className="board-page">
      <header className="board-header">
        <span className="board-title">{data?.shopName ?? 'POWER GROUP'}</span>
        <BoardClock />
      </header>
      {body}
    </div>
  );
}
