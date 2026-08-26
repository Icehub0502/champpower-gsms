import { useState, type FormEvent } from 'react';
import { signInWithEmailAndPassword, type AuthError } from 'firebase/auth';
import { auth } from '../../lib/firebase/client';
import { BoltIcon } from '../../components/ui/BoltIcon';

// Same mapping as the original app's doLogin() — Firebase error codes translated to
// Thai messages a counter-staff user can actually act on.
const ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-email': 'รูปแบบอีเมลไม่ถูกต้อง',
  'auth/user-not-found': 'ไม่พบบัญชีนี้',
  'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
  'auth/invalid-credential': 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
  'auth/too-many-requests': 'ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
  'auth/network-request-failed': 'เชื่อมต่ออินเทอร์เน็ตไม่ได้',
};

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('กรุณากรอกอีเมลและรหัสผ่าน');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      const code = (err as AuthError).code;
      setError(ERROR_MESSAGES[code] ?? `เข้าสู่ระบบไม่สำเร็จ: ${(err as AuthError).message ?? code}`);
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
          {error && <div className="login-error">{error}</div>}
          <label>
            อีเมล
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
