import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api/client';
import { isAdmin, useAuth } from '../../hooks/useAuth';
import { Icon } from '../../components/ui/Icon';

/** Matches `PublicUser` from apps/api/src/db/users.ts — no such type is exported from
 * @champpower/domain today, so it's declared here rather than reaching into the API
 * package's internals or adding a domain-package change for a single consumer. */
interface User {
  id: string;
  email: string;
  role: 'admin' | 'staff';
  name: string | null;
}

const ROLE_LABEL: Record<User['role'], string> = { admin: 'ผู้ดูแลระบบ', staff: 'พนักงาน' };

/** GET/POST/DELETE /api/users all exist and are admin-only server-side (requireAdmin
 * on the whole router) — this whole page is gated behind isAdmin(auth), same pattern
 * as ModelDetailPage/MasterPartsPage. There is no PATCH /api/users/:id (no edit-
 * in-place endpoint) — the old mock UI's "แก้ไข" button is dropped rather than faked;
 * changing a user's role/password today means deleting and recreating the account,
 * which is what the UI below actually offers instead of a fake edit action.
 *
 * useCollection isn't used here because the users router never emits a socket
 * `user:changed` event (no such broadcast exists in apps/api/src/routes/users.ts) —
 * a plain fetch + manual reload after mutations is more honest than relying on a
 * live-update mechanism that doesn't exist for this resource. */
export function UsersPage() {
  const auth = useAuth();
  const canManage = isAdmin(auth);

  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<User[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', name: '', role: 'staff' as User['role'] });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    if (!canManage) return;
    setLoading(true);
    setLoadError(null);
    api
      .get<User[]>('/api/users')
      .then((rows) => setUsers(rows))
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'โหลดรายชื่อผู้ใช้งานไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [canManage]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.email.trim() || !form.password.trim()) {
      setFormError('กรอกอีเมลและรหัสผ่านให้ครบ');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/users', {
        email: form.email.trim(),
        password: form.password,
        name: form.name.trim() || undefined,
        role: form.role,
      });
      setForm({ email: '', password: '', name: '', role: 'staff' });
      setShowForm(false);
      reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'สร้างผู้ใช้งานไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(user: User) {
    if (!window.confirm(`ลบผู้ใช้งาน "${user.name || user.email}" ใช่หรือไม่?`)) return;
    setBusy(true);
    try {
      await api.del(`/api/users/${user.id}`);
      reload();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'ลบผู้ใช้งานไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <div className="page">
        <h1>ผู้ใช้งาน</h1>
        <div className="empty-state">หน้านี้สำหรับผู้ดูแลระบบเท่านั้น</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="row-flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>ผู้ใช้งาน</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>{users.length} บัญชี</p>
        </div>
        <button type="button" className="btn" onClick={() => setShowForm((v) => !v)}>
          <Icon name="plus" size={14} /> เพิ่มผู้ใช้งาน
        </button>
      </div>

      {showForm && (
        <form className="card" style={{ marginTop: 16, padding: 16, display: 'grid', gap: 10 }} onSubmit={handleCreate}>
          {formError && <div className="pill pill-danger" style={{ justifySelf: 'start' }}>{formError}</div>}
          <div>
            <label className="field-label" htmlFor="new-user-email">อีเมล</label>
            <input
              id="new-user-email"
              className="search-input"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="new-user-password">รหัสผ่าน</label>
            <input
              id="new-user-password"
              className="search-input"
              type="password"
              required
              minLength={6}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="new-user-name">ชื่อ (ไม่บังคับ)</label>
            <input
              id="new-user-name"
              className="search-input"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="new-user-role">สิทธิ์</label>
            <select
              id="new-user-role"
              className="search-input"
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as User['role'] }))}
            >
              <option value="staff">พนักงาน</option>
              <option value="admin">ผู้ดูแลระบบ</option>
            </select>
          </div>
          <div className="row-flex" style={{ gap: 8 }}>
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'กำลังบันทึก...' : 'สร้างผู้ใช้งาน'}
            </button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => setShowForm(false)}>
              ยกเลิก
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : loadError ? (
        <div className="empty-state">{loadError}</div>
      ) : users.length === 0 ? (
        <div className="empty-state">ยังไม่มีผู้ใช้งาน</div>
      ) : (
        <div className="list-card" style={{ marginTop: 16 }}>
          {users.map((u) => (
            <div className="list-row" key={u.id}>
              <div className="avatar-circle" aria-hidden="true">{(u.name || u.email).charAt(0).toUpperCase()}</div>
              <div className="list-row-main">
                <div className="list-row-title">{u.name || u.email}</div>
                <div className="list-row-sub">{u.email}</div>
              </div>
              <span className="pill pill-info">{ROLE_LABEL[u.role]}</span>
              <div className="list-row-actions">
                <button
                  type="button"
                  className="btn danger small"
                  disabled={busy || u.id === auth.user?.id}
                  title={u.id === auth.user?.id ? 'ไม่สามารถลบบัญชีตัวเองได้' : undefined}
                  onClick={() => handleDelete(u)}
                >
                  ลบ
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
