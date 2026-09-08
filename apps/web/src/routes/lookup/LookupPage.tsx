import { useEffect, useState } from 'react';
import { normalizePlateKey, type LookupEntry } from '@champpower/domain';
import { publicApi } from '../../lib/api/client';
import { getSocket } from '../../lib/api/socket';
import { PlateBadge } from '../../components/ui/PlateBadge';
import { BoltIcon } from '../../components/ui/BoltIcon';

type SearchState = 'idle' | 'loading' | 'found' | 'not-found';

/**
 * Public, no-login "find my car" page reached by scanning a QR code and typing the
 * plate yourself — mirrors /board's public-read pattern. Reads only /lookup/{plateKey},
 * which lookupPayloadFor() in @champpower/domain keeps deliberately thin (no phone,
 * price, notes, or signatures) since anyone who knows a plate can search it.
 */
export function LookupPage() {
  const [plateInput, setPlateInput] = useState('');
  const [state, setState] = useState<SearchState>('idle');
  const [entry, setEntry] = useState<LookupEntry | null>(null);
  const [plateKey, setPlateKey] = useState('');

  async function search() {
    const key = normalizePlateKey(plateInput);
    if (!key) return;
    setState('loading');
    setEntry(null);
    setPlateKey(key);
    try {
      const data = await publicApi.get<LookupEntry>(`/api/public/lookup?plate=${encodeURIComponent(key)}`);
      setEntry(data);
      setState('found');
    } catch {
      // Any failure (404 not found, network error) reads the same to the customer:
      // nothing to show for this plate right now.
      setEntry(null);
      setState('not-found');
    }
  }

  // Public socket connection (no JWT) — refetch the currently displayed plate if the
  // backend signals its projection changed (e.g. staff updated the job while the
  // customer has this page open), matching the board page's live-update behavior.
  useEffect(() => {
    if (!plateKey) return;
    const socket = getSocket();
    function onChanged(payload: { plateKey?: string }) {
      if (payload?.plateKey !== plateKey) return;
      publicApi
        .get<LookupEntry>(`/api/public/lookup?plate=${encodeURIComponent(plateKey)}`)
        .then((data) => setEntry(data))
        .catch(() => {
          setEntry(null);
          setState('not-found');
        });
    }
    socket.on('lookup:changed', onChanged);
    return () => {
      socket.off('lookup:changed', onChanged);
    };
  }, [plateKey]);

  return (
    <div className="lookup-page">
      <header className="lookup-header">
        <BoltIcon size={20} /> POWER GROUP
      </header>

      <div className="lookup-card">
        <h1>ค้นหารถของคุณ</h1>
        <p className="page-sub">กรอกทะเบียนรถเพื่อดูสถานะและรายการอะไหล่ที่เปลี่ยน</p>
        <div className="row-flex">
          <input
            className="lookup-input"
            value={plateInput}
            onChange={(e) => setPlateInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
            placeholder="เช่น 1กข1234"
            autoFocus
          />
          <button className="btn hazard" onClick={search} disabled={!plateInput.trim()}>
            ค้นหา
          </button>
        </div>

        {state === 'loading' && <div className="page-loading">กำลังค้นหา...</div>}
        {state === 'not-found' && (
          <div className="empty-state">ไม่พบข้อมูลรถทะเบียนนี้ — ตรวจสอบทะเบียนอีกครั้ง</div>
        )}
      </div>

      {state === 'found' && entry && (
        <div className="lookup-card">
          <div className="job-card-top">
            <PlateBadge plate={entry.plate} province={entry.province} size="lg" />
          </div>
          <h2>{entry.brand} {entry.model}{entry.color ? ` · ${entry.color}` : ''}</h2>
          <p className="page-sub">{entry.customerName}</p>

          {entry.photo && <img className="lookup-car-photo" src={entry.photo} alt="รูปรถ" />}

          <h3>รายการอะไหล่ที่เปลี่ยน ({entry.parts.length})</h3>
          {entry.parts.length === 0 ? (
            <div className="empty-state">ยังไม่มีรายการอะไหล่</div>
          ) : (
            <div className="lookup-parts">
              {entry.parts.map((p, i) => (
                <div className="lookup-part-row" key={i}>
                  {p.photos && p.photos.length > 0 && (
                    <div className="lookup-part-photos">
                      {p.photos.map((photo, j) => (
                        <img key={j} className="part-photo-thumb" src={photo} alt={p.name} />
                      ))}
                    </div>
                  )}
                  <div className="lookup-part-info">
                    <div className="meta strong">{p.name}</div>
                    <div className="meta">
                      {p.brand ? `${p.brand} · ` : ''}
                      {p.qty || '1'} {p.unit || 'ชิ้น'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
