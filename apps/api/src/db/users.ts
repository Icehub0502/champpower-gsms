import { pool } from './pool.js';
import { newId } from '../lib/ids.js';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: 'admin' | 'staff';
  name: string | null;
  created_at: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  role: 'admin' | 'staff';
  name: string | null;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const [rows] = await pool.query(`SELECT * FROM users WHERE email = ?`, [email]);
  const list = rows as UserRow[];
  return list.length ? list[0]! : null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const [rows] = await pool.query(`SELECT * FROM users WHERE id = ?`, [id]);
  const list = rows as UserRow[];
  return list.length ? list[0]! : null;
}

export async function listUsers(): Promise<PublicUser[]> {
  const [rows] = await pool.query(`SELECT id, email, role, name FROM users ORDER BY created_at ASC`);
  return rows as PublicUser[];
}

export async function createUser(input: {
  email: string;
  passwordHash: string;
  role: 'admin' | 'staff';
  name?: string;
}): Promise<PublicUser> {
  const id = newId();
  await pool.query(`INSERT INTO users (id, email, password_hash, role, name) VALUES (?, ?, ?, ?, ?)`, [
    id,
    input.email,
    input.passwordHash,
    input.role,
    input.name || null,
  ]);
  return { id, email: input.email, role: input.role, name: input.name || null };
}

export async function deleteUser(id: string): Promise<boolean> {
  const [result] = await pool.query(`DELETE FROM users WHERE id = ?`, [id]);
  return (result as { affectedRows: number }).affectedRows > 0;
}
