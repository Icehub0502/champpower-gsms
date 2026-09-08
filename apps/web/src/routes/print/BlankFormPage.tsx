import { useNavigate } from 'react-router-dom';

const BLANK_ROWS = 14;

export function BlankFormPage() {
  const navigate = useNavigate();

  return (
    <div className="page blank-form-page">
      <div className="row-flex no-print" style={{ justifyContent: 'space-between' }}>
        <button className="back-link" onClick={() => navigate('/settings')}>
          ‹ กลับตั้งค่า
        </button>
      </div>

      <h1>ใบเปล่าและเอกสารรับรถ</h1>
      <p className="page-sub">แบบฟอร์มกระดาษสำรอง ใช้เมื่อระบบขัดข้องหรือไม่สามารถเข้าถึงอินเทอร์เน็ตได้</p>

      <div className="row-flex no-print" style={{ marginBottom: 14 }}>
        <button className="btn" onClick={() => window.print()}>
          พิมพ์ใบเปล่า
        </button>
        <button className="btn secondary" onClick={() => window.print()}>
          บันทึก PDF
        </button>
        <button className="btn secondary" onClick={() => navigate('/settings')}>
          กลับตั้งค่า
        </button>
      </div>

      <div className="kpi-grid no-print">
        <div className="kpi-card kpi-blue">
          <div className="kpi-card-label">ข้อมูลลูกค้า</div>
          <div className="kpi-card-sub">ชื่อ, โทรศัพท์, วันที่, เลขที่งาน</div>
        </div>
        <div className="kpi-card kpi-gold">
          <div className="kpi-card-label">ข้อมูลรถ</div>
          <div className="kpi-card-sub">ทะเบียน, จังหวัด, ยี่ห้อ/รุ่น, ปี, สี, เลขไมล์</div>
        </div>
        <div className="kpi-card kpi-green">
          <div className="kpi-card-label">ตรวจรับรถ</div>
          <div className="kpi-card-sub">อาการ, รายการตรวจ, รูปถ่าย, ลายเซ็น</div>
        </div>
      </div>

      <div className="card blank-form-sheet">
        <div className="blank-form-head">
          <div className="blank-form-brand">POWER GROUP</div>
          <div className="blank-form-title">ใบรับรถ / Check-in Form</div>
        </div>

        <div className="blank-form-grid">
          <label className="blank-form-field">ชื่อลูกค้า<span className="blank-line" /></label>
          <label className="blank-form-field">โทรศัพท์<span className="blank-line" /></label>
          <label className="blank-form-field">วันที่<span className="blank-line" /></label>
          <label className="blank-form-field">เลขที่งาน<span className="blank-line" /></label>
          <label className="blank-form-field">ทะเบียนรถ<span className="blank-line" /></label>
          <label className="blank-form-field">จังหวัด<span className="blank-line" /></label>
          <label className="blank-form-field">ยี่ห้อ / รุ่น<span className="blank-line" /></label>
          <label className="blank-form-field">ปี<span className="blank-line" /></label>
          <label className="blank-form-field">สี<span className="blank-line" /></label>
          <label className="blank-form-field">เลขไมล์<span className="blank-line" /></label>
        </div>

        <label className="blank-form-field blank-form-field-wide">อาการ / รายการตรวจ<span className="blank-line" /></label>

        <table className="parts-table blank-form-table">
          <thead>
            <tr>
              <th style={{ width: 50 }}>ลำดับ</th>
              <th>รายการ</th>
              <th style={{ width: 110 }}>จำนวน/หน่วย</th>
              <th style={{ width: 160 }}>ราคา/หมายเหตุ</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: BLANK_ROWS }, (_, i) => (
              <tr key={i}>
                <td className="center">{i + 1}</td>
                <td>&nbsp;</td>
                <td>&nbsp;</td>
                <td>&nbsp;</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="blank-form-sign-row">
          <label className="blank-form-field">ลายเซ็นเจ้าหน้าที่<span className="blank-line" /></label>
          <label className="blank-form-field">ลายเซ็นลูกค้า<span className="blank-line" /></label>
        </div>
      </div>
    </div>
  );
}
