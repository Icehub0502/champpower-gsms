import type { Vehicle } from '@champpower/domain';
import { pool } from './pool.js';
import { newId } from '../lib/ids.js';

interface VehicleRow {
  id: string;
  customer_id: string;
  plate: string;
  province: string | null;
  brand: string;
  model: string;
  year: string | null;
  color: string | null;
  mileage: string | null;
}

function rowToVehicle(r: VehicleRow): Vehicle {
  return {
    id: r.id,
    customerId: r.customer_id,
    plate: r.plate,
    province: r.province || undefined,
    brand: r.brand,
    model: r.model,
    year: r.year || undefined,
    color: r.color || undefined,
    mileage: r.mileage || undefined,
  };
}

export async function listVehicles(plate?: string): Promise<Vehicle[]> {
  if (plate) {
    const [rows] = await pool.query(`SELECT * FROM vehicles WHERE plate = ? ORDER BY created_at DESC`, [plate]);
    return (rows as VehicleRow[]).map(rowToVehicle);
  }
  const [rows] = await pool.query(`SELECT * FROM vehicles ORDER BY created_at DESC`);
  return (rows as VehicleRow[]).map(rowToVehicle);
}

export async function getVehicleById(id: string): Promise<Vehicle | null> {
  const [rows] = await pool.query(`SELECT * FROM vehicles WHERE id = ?`, [id]);
  const list = rows as VehicleRow[];
  return list.length ? rowToVehicle(list[0]!) : null;
}

export async function createVehicle(input: Omit<Vehicle, 'id'>): Promise<Vehicle> {
  const id = newId();
  await pool.query(
    `INSERT INTO vehicles (id, customer_id, plate, province, brand, model, year, color, mileage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.customerId, input.plate, input.province || null, input.brand, input.model, input.year || null, input.color || null, input.mileage || null],
  );
  return (await getVehicleById(id))!;
}

export async function updateVehicle(id: string, patch: Partial<Omit<Vehicle, 'id'>>): Promise<Vehicle | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, string> = {
    customerId: 'customer_id',
    plate: 'plate',
    province: 'province',
    brand: 'brand',
    model: 'model',
    year: 'year',
    color: 'color',
    mileage: 'mileage',
  };
  for (const [key, column] of Object.entries(map)) {
    if (key in patch) {
      sets.push(`${column} = ?`);
      values.push((patch as Record<string, unknown>)[key] ?? null);
    }
  }
  if (sets.length === 0) return getVehicleById(id);
  values.push(id);
  await pool.query(`UPDATE vehicles SET ${sets.join(', ')} WHERE id = ?`, values);
  return getVehicleById(id);
}
