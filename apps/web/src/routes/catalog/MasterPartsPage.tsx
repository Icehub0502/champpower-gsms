import { useState } from 'react';
import { addDoc, collection, deleteDoc, doc } from 'firebase/firestore';
import { DEFAULT_MASTER_PARTS, PART_CATEGORIES, groupByCategory, type MasterPart } from '@champpower/domain';
import { db } from '../../lib/firebase/client';
import { useCollection } from '../../hooks/useCollection';

export function MasterPartsPage() {
  const parts = useCollection<MasterPart>('masterParts');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>(PART_CATEGORIES[0]);
  const [busy, setBusy] = useState(false);

  async function addPart() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await addDoc(collection(db, 'masterParts'), { name: trimmed, category });
      setName('');
    } finally {
      setBusy(false);
    }
  }

  async function seedDefaults() {
    setBusy(true);
    try {
      const existingNames = new Set(parts.rows.map((p) => p.name));
      const missing = DEFAULT_MASTER_PARTS.filter((p) => !existingNames.has(p.name));
      await Promise.all(missing.map((p) => addDoc(collection(db, 'masterParts'), { name: p.name, category: p.category })));
    } finally {
      setBusy(false);
    }
  }

  async function removePart(id: string) {
    await deleteDoc(doc(db, 'masterParts', id));
  }

  const grouped = groupByCategory(parts.rows);

  return (
    <div className="page">
      <h1>สินค้า / อะไหล่กลาง</h1>
      <p className="page-sub">รายการอะไหล่ทั่วไปที่ใช้ผูกกับรุ่นรถ ({parts.rows.length} รายการ)</p>

      <div className="card">
        <div className="row-flex">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่ออะไหล่" />
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {PART_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button className="btn" onClick={addPart} disabled={busy}>
            เพิ่ม
          </button>
        </div>
        {parts.rows.length === 0 && (
          <button className="btn secondary" style={{ marginTop: 10 }} onClick={seedDefaults} disabled={busy}>
            โหลดรายการอะไหล่เริ่มต้น ({DEFAULT_MASTER_PARTS.length} รายการ)
          </button>
        )}
      </div>

      {grouped.map((g) => (
        <div className="card" key={g.category}>
          <h3>{g.category}</h3>
          <div className="complaint-chips">
            {g.items.map((p) => (
              <span className="chip active" key={p.id}>
                {p.name}
                <button
                  className="chip-remove"
                  onClick={() => removePart(p.id)}
                  aria-label={`ลบ ${p.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
