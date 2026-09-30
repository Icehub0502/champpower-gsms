import type { useCheckInPhotos } from './useCheckInPhotos';
import { MAX_PHOTOS } from './useCheckInPhotos';

type Photos = ReturnType<typeof useCheckInPhotos>;

const STATUS_TEXT = {
  uploading: 'กำลังอัปโหลด…',
  done: 'อัปโหลดแล้ว',
  failed: 'อัปโหลดไม่สำเร็จ',
  needs_auth: 'รอเข้าสู่ระบบใหม่ — รูปยังอยู่',
} as const;

/**
 * รูปรถตอนรับ (Figma 03's two dropzones = camera and gallery, decision 1).
 * Reorder is by ◀ ▶ buttons, not drag — dependable with a thumb on a phone.
 * Every state is written out in words; nothing is signalled by colour alone.
 */
export function CheckInPhotos({ photos, disabled }: { photos: Photos; disabled: boolean }) {
  const off = disabled || photos.full;
  return (
    <section className="card ci-card">
      <h3>รูปรถตอนรับ</h3>
      <p className="ci-card-sub">ถ่ายรอบคันให้เห็นสภาพรถตอนรับ — รูปแรกเป็นรูปปก ({photos.photos.length}/{MAX_PHOTOS})</p>
      <div className="ci-photo-pickers">
        <label className={`btn secondary ci-photo-btn${off ? ' is-disabled' : ''}`}>
          📷 ถ่ายรูป
          <input className="sr-only" type="file" accept="image/*" capture="environment" disabled={off}
            onChange={(e) => { photos.add(e.target.files); e.target.value = ''; }} />
        </label>
        <label className={`btn secondary ci-photo-btn${off ? ' is-disabled' : ''}`}>
          🖼️ เลือกรูป
          <input className="sr-only" type="file" accept="image/*" multiple disabled={off}
            onChange={(e) => { photos.add(e.target.files); e.target.value = ''; }} />
        </label>
      </div>

      {photos.sessionExpired && (
        <div className="ci-photo-session" role="alert">
          <p>⚠ หมดเวลาการเข้าสู่ระบบ — รูปที่ยังไม่ขึ้นยังเก็บไว้ในหน้านี้ เข้าสู่ระบบใหม่ (เช่นในแท็บอื่น) แล้วกดส่งรูปอีกครั้ง</p>
          <button type="button" className="btn secondary small" disabled={disabled} onClick={photos.retryAuth}>
            ส่งรูปที่ค้างอีกครั้ง
          </button>
        </div>
      )}

      {photos.photos.length > 0 && (
        <ol className="ci-photo-list">
          {photos.photos.map((p, i) => (
            <li key={p.key} className={`ci-photo is-${p.status}`}>
              <img src={p.previewUrl} alt={`รูปรถที่ ${i + 1}`} />
              <span className="ci-photo-tags">
                {i === 0 && <span className="ci-photo-cover">รูปปก</span>}
                <span className="ci-photo-status" role={p.status === 'failed' ? 'alert' : undefined}>
                  {p.status === 'failed' && '⚠ '}
                  {STATUS_TEXT[p.status]}
                </span>
              </span>
              <span className="ci-photo-actions">
                <button type="button" className="btn secondary small" disabled={disabled || i === 0}
                  aria-label={`เลื่อนรูปที่ ${i + 1} ไปก่อนหน้า`} onClick={() => photos.move(p.key, -1)}>◀</button>
                <button type="button" className="btn secondary small" disabled={disabled || i === photos.photos.length - 1}
                  aria-label={`เลื่อนรูปที่ ${i + 1} ไปถัดไป`} onClick={() => photos.move(p.key, 1)}>▶</button>
                {p.status === 'failed' && (
                  <button type="button" className="btn secondary small" disabled={disabled} onClick={() => photos.retry(p.key)}>
                    ลองใหม่
                  </button>
                )}
                <button type="button" className="btn danger small" disabled={disabled}
                  aria-label={`ลบรูปที่ ${i + 1}`} onClick={() => photos.remove(p.key)}>ลบ</button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
