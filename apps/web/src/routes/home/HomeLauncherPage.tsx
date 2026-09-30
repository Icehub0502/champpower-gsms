import { useNavigate } from 'react-router-dom';
import { BoltIcon } from '../../components/ui/BoltIcon';

/** Post-login "which app" picker — the new root landing page shown right after
 * sign-in. Replaces the old `Navigate to="/jobs"` default so staff explicitly
 * choose which surface they want (staff console, customer board, or the
 * public reception QR preview) instead of always landing straight in /jobs. */
export function HomeLauncherPage() {
  const navigate = useNavigate();

  return (
    <div className="launcher-page">
      <div className="launcher-top">
        <BoltIcon size={18} /> POWER <span className="accent">GROUP</span>
      </div>
      <div className="launcher-body">
        <h1>เลือกหน้าที่ต้องการเปิด</h1>
        <p className="launcher-sub">เลือกแอปที่ต้องการใช้งานสำหรับบทบาทของคุณ</p>

        <div className="launcher-grid">
          <div className="launcher-card">
            <span className="launcher-chip">STAFF APP</span>
            <h2>แอปสำหรับพนักงาน</h2>
            <p>รับรถ • ใบงาน • อะไหล่ • รายได้ • ตั้งค่า</p>
            <button type="button" className="btn" onClick={() => navigate('/today')}>
              เข้าสู่ระบบงาน
            </button>
          </div>

          <div className="launcher-card gold">
            <span className="launcher-chip">CUSTOMER BOARD</span>
            <h2>กระดานสถานะลูกค้า</h2>
            <p>แสดงคิว ทะเบียน รุ่นรถ และสถานะ โดยไม่เปิดข้อมูลส่วนตัว</p>
            <button type="button" className="btn secondary" onClick={() => navigate('/board')}>
              เปิดกระดาน
            </button>
          </div>

          <div className="launcher-card green">
            <span className="launcher-chip">RECEPTION</span>
            <h2>หน้ารับรอง / QR</h2>
            <p>ใช้สำหรับจอหน้าร้านหรือ QR ที่โต๊ะรับรอง ให้ลูกค้าค้นหารถของตัวเอง</p>
            <button type="button" className="btn secondary" onClick={() => navigate('/lookup')}>
              ดูตัวอย่าง
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
