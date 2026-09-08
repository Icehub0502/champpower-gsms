import { useNavigate } from 'react-router-dom';

// TODO: hub links to real settings sub-pages once each is backed by data; the
// business-settings / update-check / board-QR cards below are placeholders
// with no destination yet (they mirror the Figma hub but nothing to wire to).
export function SettingsPage() {
  const navigate = useNavigate();

  return (
    <div className="page">
      <h1>ตั้งค่า</h1>
      <p className="page-sub">จัดการข้อมูลหลัก ผู้ใช้งาน และความปลอดภัยของระบบ</p>

      <div className="hub-grid">
        <div className="hub-card">
          <h3>แคตตาล็อก / ข้อมูลหลัก</h3>
          <p>รุ่นรถ • สินค้า • ช่าง • ตำราราคา</p>
          <button type="button" className="btn secondary" onClick={() => navigate('/models')}>
            จัดการข้อมูล
          </button>
        </div>

        <div className="hub-card">
          <h3>ผู้ใช้งานและสิทธิ์</h3>
          <p>กำหนดสิทธิ์ Admin / Service / Technician</p>
          <button type="button" className="btn secondary" onClick={() => navigate('/settings/users')}>
            จัดการผู้ใช้
          </button>
        </div>

        <div className="hub-card">
          <h3>ทีมช่าง</h3>
          <p>รายชื่อช่าง ความเชี่ยวชาญ และสถานะงานที่รับผิดชอบ</p>
          <button type="button" className="btn secondary" onClick={() => navigate('/settings/technicians')}>
            จัดการทีมช่าง
          </button>
        </div>

        <div className="hub-card">
          <h3>กระดานสถานะลูกค้า</h3>
          <p>สร้างลิงก์และ QR สำหรับหน้ารอรับรถ</p>
          <button type="button" className="btn secondary" onClick={() => navigate('/board')}>
            เปิดการตั้งค่า
          </button>
        </div>

        <div className="hub-card">
          <h3>สำรอง / นำเข้าข้อมูล</h3>
          <p>ดาวน์โหลดไฟล์สำรอง หรือนำเข้าจากระบบเดิม</p>
          <button type="button" className="btn secondary" onClick={() => navigate('/jobs')}>
            สำรองข้อมูล
          </button>
        </div>

        <div className="hub-card">
          <h3>เอกสารพิมพ์</h3>
          <p>ใบเปล่ารับรถสำรอง ใช้เมื่อระบบใช้งานไม่ได้</p>
          <button type="button" className="btn secondary" onClick={() => navigate('/print/blank-checkin')}>
            เปิดใบเปล่า
          </button>
        </div>

        <div className="hub-card">
          <h3>เวอร์ชันระบบ</h3>
          <p>เวอร์ชันที่เครื่องนี้ใช้อยู่: v4.0 Redesign</p>
          <button type="button" className="btn secondary" disabled>
            ตรวจอัปเดต
          </button>
        </div>
      </div>

      <h2 className="section-title">ความปลอดภัยและการจัดการข้อมูล</h2>
      <div className="hub-grid">
        <div className="hub-card">
          <h3>การลบข้อมูล</h3>
          <p>ดูรายการที่ถูกลบและกู้คืนได้ (เก็บไว้ 30 วัน)</p>
          <button type="button" className="btn secondary" onClick={() => navigate('/settings/trash')}>
            เปิดถังขยะ
          </button>
        </div>

        <div className="hub-card">
          <h3>ข้อมูลบนคลาวด์</h3>
          <p>
            <span className="pill pill-success">ออนไลน์</span> &nbsp;ซิงก์อัตโนมัติ • สถานะล่าสุด 18:42
          </p>
        </div>
      </div>
    </div>
  );
}
