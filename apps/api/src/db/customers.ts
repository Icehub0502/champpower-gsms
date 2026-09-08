import type { Customer } from '@champpower/domain';
import { pool } from './pool.js';
import { newId } from '../lib/ids.js';

interface CustomerRow {
  id: string;
  name: string | null;
  phone: string | null;
}

function rowToCustomer(r: CustomerRow): Customer {
  return { id: r.id, name: r.name || undefined, phone: r.phone || undefined };
}

export async function listCustomers(phone?: string): Promise<Customer[]> {
  if (phone) {
    const [rows] = await pool.query(`SELECT * FROM customers WHERE phone = ? ORDER BY created_at DESC`, [phone]);
    return (rows as CustomerRow[]).map(rowToCustomer);
  }
  const [rows] = await pool.query(`SELECT * FROM customers ORDER BY created_at DESC`);
  return (rows as CustomerRow[]).map(rowToCustomer);
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  const [rows] = await pool.query(`SELECT * FROM customers WHERE id = ?`, [id]);
  const list = rows as CustomerRow[];
  return list.length ? rowToCustomer(list[0]!) : null;
}

export async function createCustomer(input: Omit<Customer, 'id'>): Promise<Customer> {
  const id = newId();
  await pool.query(`INSERT INTO customers (id, name, phone) VALUES (?, ?, ?)`, [id, input.name || null, input.phone || null]);
  return (await getCustomerById(id))!;
}

export async function updateCustomer(id: string, patch: Partial<Omit<Customer, 'id'>>): Promise<Customer | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if ('name' in patch) {
    sets.push('name = ?');
    values.push(patch.name || null);
  }
  if ('phone' in patch) {
    sets.push('phone = ?');
    values.push(patch.phone || null);
  }
  if (sets.length === 0) return getCustomerById(id);
  values.push(id);
  await pool.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`, values);
  return getCustomerById(id);
}
