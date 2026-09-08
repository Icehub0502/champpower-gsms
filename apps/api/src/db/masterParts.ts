import type { MasterPart } from '@champpower/domain';
import { pool } from './pool.js';
import { newId } from '../lib/ids.js';

interface Row {
  id: string;
  name: string;
  category: string;
  created_at: Date | string;
}

function rowToPart(r: Row): MasterPart {
  return { id: r.id, name: r.name, category: r.category, createdAt: new Date(r.created_at).toISOString() };
}

export async function listMasterParts(): Promise<MasterPart[]> {
  const [rows] = await pool.query(`SELECT id, name, category, created_at FROM master_parts ORDER BY category ASC, name ASC`);
  return (rows as Row[]).map(rowToPart);
}

export async function createMasterPart(input: Omit<MasterPart, 'id' | 'createdAt'>): Promise<MasterPart> {
  const id = newId();
  await pool.query(`INSERT INTO master_parts (id, name, category) VALUES (?, ?, ?)`, [id, input.name, input.category]);
  const [rows] = await pool.query(`SELECT id, name, category, created_at FROM master_parts WHERE id = ?`, [id]);
  return rowToPart((rows as Row[])[0]!);
}

export async function updateMasterPart(id: string, patch: Partial<Omit<MasterPart, 'id'>>): Promise<MasterPart | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.category !== undefined) {
    sets.push('category = ?');
    values.push(patch.category);
  }
  if (sets.length === 0) {
    const [rows] = await pool.query(`SELECT id, name, category, created_at FROM master_parts WHERE id = ?`, [id]);
    const list = rows as Row[];
    return list.length ? rowToPart(list[0]!) : null;
  }
  values.push(id);
  await pool.query(`UPDATE master_parts SET ${sets.join(', ')} WHERE id = ?`, values);
  const [rows] = await pool.query(`SELECT id, name, category, created_at FROM master_parts WHERE id = ?`, [id]);
  const list = rows as Row[];
  return list.length ? rowToPart(list[0]!) : null;
}

export async function deleteMasterPart(id: string): Promise<boolean> {
  const [result] = await pool.query(`DELETE FROM master_parts WHERE id = ?`, [id]);
  return (result as { affectedRows: number }).affectedRows > 0;
}
