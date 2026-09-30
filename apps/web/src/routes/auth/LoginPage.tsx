import { useState, type FormEvent } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { ApiError } from '../../lib/api/client';
import { BoltIcon } from '../../components/ui/BoltIcon';

export function LoginPage() {
  const { login, logoutError } = useAuth();
  // "loginId": the API accepts either an email (office staff) or a bare
  // username (technicians with no email — CLAUDE.md §8 "users.login_id" is
  // "อีเมล หรือ username สำหรับช่างที่ไม่มีอีเมล"), so this is not necessarily
  // an email address.
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!loginId.trim() || !password) {
      setError('กรุณากรอกชื่อผู้ใช้งานและรหัสผ่าน');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await login(loginId.trim(), password);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 401 ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : `เข้าสู่ระบบไม่สำเร็จ: ${err.message}`);
      } else {
        setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page-v2">
      <div className="login-hero">
        <div className="login-hero-brand">
          POWER <span className="accent">GROUP</span>
        </div>
        <p className="login-hero-tag">Garage Service Management System</p>
        <h1>จัดการงานหน้าร้าน อะไหล่ ช่าง และสถานะรถในที่เดียว</h1>
        <p className="login-hero-sub">ออกแบบสำหรับทีมรับรถ ช่าง ฝ่ายขาย และผู้ดูแลระบบ</p>
        <div className="login-hero-features">
          <div className="login-hero-feature">
            <span className="dot red" aria-hidden="true" /> รับรถเร็วขึ้นด้วยฟอร์มที่กรอกน้อยลง
          </div>
          <div className="login-hero-feature">
            <span className="dot gold" aria-hidden="true" /> เห็นสถานะรถทุกคันแบบเรียลไทม์
          </div>
          <div className="login-hero-feature">
            <span className="dot green" aria-hidden="true" /> บริหารงานอู่ได้ง่ายขึ้นในที่เดียว
          </div>
        </div>
      </div>

      <div className="login-panel">
        <form className="login-card" onSubmit={handleSubmit}>
          <div className="hazard-edge" />
          <h1>
            <BoltIcon size={20} /> เข้าสู่ระบบ
          </h1>
          <p className="login-sub">ระบบจัดการอู่บริการ (GSMS)</p>
          {logoutError && <div className="login-error" role="alert">{logoutError}</div>}
          {error && <div className="login-error">{error}</div>}
          <label>
            ชื่อผู้ใช้งาน
            <input
              type="text"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              autoComplete="username"
              placeholder="you@example.com"
            />
          </label>
          <label>
            รหัสผ่าน
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="รหัสผ่าน"
            />
          </label>
          <button type="submit" className="btn block" disabled={busy}>
            {busy ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ'}
          </button>
          <div className="login-note">
            บัญชีผู้ใช้สร้างโดยผู้ดูแลระบบเท่านั้น
            <br />
            หากเข้าไม่ได้ กรุณาติดต่อผู้ดูแล
          </div>
        </form>
      </div>
    </div>
  );
}
