import type { ModelPart, ModelPartBrand, Promotion, VehicleModel } from '@champpower/domain';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from './pool.js';
import { newId } from '../lib/ids.js';

interface ModelRow {
  id: string;
  brand: string;
  name: string;
  year_range: string | null;
  seed_key: string | null;
}

async function loadPartsAndPromotions(modelIds: string[]): Promise<{
  parts: Map<string, ModelPart[]>;
  promotions: Map<string, Promotion[]>;
}> {
  const parts = new Map<string, ModelPart[]>();
  const promotions = new Map<string, Promotion[]>();
  if (modelIds.length === 0) return { parts, promotions };

  const [partRows] = await pool.query(
    `SELECT id, model_id, part_name, category, qty, unit, variant FROM model_parts WHERE model_id IN (?) ORDER BY sort_order ASC`,
    [modelIds],
  );
  const mp = partRows as {
    id: string;
    model_id: string;
    part_name: string;
    category: string | null;
    qty: string | null;
    unit: string | null;
    variant: string | null;
  }[];
  const partIds = mp.map((p) => p.id);
  const brandsByPart = new Map<string, ModelPartBrand[]>();
  if (partIds.length > 0) {
    const [brandRows] = await pool.query(
      `SELECT id, model_part_id, name, price FROM model_part_brands WHERE model_part_id IN (?) ORDER BY sort_order ASC`,
      [partIds],
    );
    for (const r of brandRows as { id: string; model_part_id: string; name: string; price: string | null }[]) {
      const list = brandsByPart.get(r.model_part_id) || [];
      list.push({ id: r.id, name: r.name, price: r.price || undefined });
      brandsByPart.set(r.model_part_id, list);
    }
  }
  for (const r of mp) {
    const list = parts.get(r.model_id) || [];
    list.push({
      id: r.id,
      partName: r.part_name,
      category: r.category || undefined,
      qty: r.qty || undefined,
      unit: r.unit || undefined,
      variant: r.variant || undefined,
      brands: brandsByPart.get(r.id) || [],
    });
    parts.set(r.model_id, list);
  }

  const [promoRows] = await pool.query(
    `SELECT id, model_id, name, price, date_start, date_end, mileage_start, mileage_end FROM promotions WHERE model_id IN (?) ORDER BY sort_order ASC`,
    [modelIds],
  );
  const pr = promoRows as {
    id: string;
    model_id: string;
    name: string;
    price: string | null;
    date_start: Date | null;
    date_end: Date | null;
    mileage_start: string | null;
    mileage_end: string | null;
  }[];
  const promoIds = pr.map((p) => p.id);
  const itemsByPromo = new Map<string, string[]>();
  if (promoIds.length > 0) {
    const [itemRows] = await pool.query(
      `SELECT promotion_id, item_id FROM promotion_items WHERE promotion_id IN (?) ORDER BY sort_order ASC`,
      [promoIds],
    );
    for (const r of itemRows as { promotion_id: string; item_id: string }[]) {
      const list = itemsByPromo.get(r.promotion_id) || [];
      list.push(r.item_id);
      itemsByPromo.set(r.promotion_id, list);
    }
  }
  const dateStr = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);
  for (const r of pr) {
    const list = promotions.get(r.model_id) || [];
    list.push({
      id: r.id,
      name: r.name,
      itemIds: itemsByPromo.get(r.id) || [],
      price: r.price || undefined,
      dateStart: dateStr(r.date_start),
      dateEnd: dateStr(r.date_end),
      mileageStart: r.mileage_start || undefined,
      mileageEnd: r.mileage_end || undefined,
    });
    promotions.set(r.model_id, list);
  }

  return { parts, promotions };
}

function rowToModel(r: ModelRow, parts: ModelPart[], promotions: Promotion[]): VehicleModel {
  return {
    id: r.id,
    brand: r.brand,
    name: r.name,
    yearRange: r.year_range || undefined,
    seedKey: r.seed_key || undefined,
    parts,
    promotions: promotions.length ? promotions : undefined,
  };
}

export async function listModels(): Promise<VehicleModel[]> {
  const [rows] = await pool.query(`SELECT * FROM vehicle_models ORDER BY brand ASC, name ASC`);
  const modelRows = rows as ModelRow[];
  const { parts, promotions } = await loadPartsAndPromotions(modelRows.map((r) => r.id));
  return modelRows.map((r) => rowToModel(r, parts.get(r.id) || [], promotions.get(r.id) || []));
}

export async function getModelById(id: string): Promise<VehicleModel | null> {
  const [rows] = await pool.query(`SELECT * FROM vehicle_models WHERE id = ?`, [id]);
  const modelRows = rows as ModelRow[];
  if (modelRows.length === 0) return null;
  const { parts, promotions } = await loadPartsAndPromotions([id]);
  return rowToModel(modelRows[0]!, parts.get(id) || [], promotions.get(id) || []);
}

export interface ModelInput {
  brand: string;
  name: string;
  yearRange?: string;
  seedKey?: string;
  parts?: ModelPart[];
  promotions?: Promotion[];
}

async function replaceParts(conn: PoolConnection, modelId: string, parts: ModelPart[]): Promise<void> {
  await conn.query(`DELETE FROM model_parts WHERE model_id = ?`, [modelId]);
  let order = 0;
  for (const p of parts) {
    const partId = p.id || newId();
    await conn.query(
      `INSERT INTO model_parts (id, model_id, part_name, category, qty, unit, variant, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [partId, modelId, p.partName, p.category || null, p.qty || null, p.unit || null, p.variant || null, order++],
    );
    let brandOrder = 0;
    for (const b of p.brands || []) {
      await conn.query(`INSERT INTO model_part_brands (id, model_part_id, name, price, sort_order) VALUES (?, ?, ?, ?, ?)`, [
        b.id || newId(),
        partId,
        b.name,
        b.price || null,
        brandOrder++,
      ]);
    }
  }
}

async function replacePromotions(conn: PoolConnection, modelId: string, promotions: Promotion[]): Promise<void> {
  await conn.query(`DELETE FROM promotions WHERE model_id = ?`, [modelId]);
  let order = 0;
  for (const promo of promotions) {
    const promoId = promo.id || newId();
    await conn.query(
      `INSERT INTO promotions (id, model_id, name, price, date_start, date_end, mileage_start, mileage_end, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        promoId,
        modelId,
        promo.name,
        promo.price || null,
        promo.dateStart || null,
        promo.dateEnd || null,
        promo.mileageStart || null,
        promo.mileageEnd || null,
        order++,
      ],
    );
    let itemOrder = 0;
    for (const itemId of promo.itemIds || []) {
      await conn.query(`INSERT INTO promotion_items (id, promotion_id, item_id, sort_order) VALUES (?, ?, ?, ?)`, [
        newId(),
        promoId,
        itemId,
        itemOrder++,
      ]);
    }
  }
}

export async function createModel(input: ModelInput): Promise<VehicleModel> {
  const id = newId();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`INSERT INTO vehicle_models (id, brand, name, year_range, seed_key) VALUES (?, ?, ?, ?, ?)`, [
      id,
      input.brand,
      input.name,
      input.yearRange || null,
      input.seedKey || null,
    ]);
    if (input.parts) await replaceParts(conn, id, input.parts);
    if (input.promotions) await replacePromotions(conn, id, input.promotions);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return (await getModelById(id))!;
}

export async function updateModel(id: string, patch: Partial<ModelInput>): Promise<VehicleModel | null> {
  const existing = await getModelById(id);
  if (!existing) return null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.brand !== undefined) {
      sets.push('brand = ?');
      values.push(patch.brand);
    }
    if (patch.name !== undefined) {
      sets.push('name = ?');
      values.push(patch.name);
    }
    if (patch.yearRange !== undefined) {
      sets.push('year_range = ?');
      values.push(patch.yearRange || null);
    }
    if (patch.seedKey !== undefined) {
      sets.push('seed_key = ?');
      values.push(patch.seedKey || null);
    }
    if (sets.length > 0) {
      values.push(id);
      await conn.query(`UPDATE vehicle_models SET ${sets.join(', ')} WHERE id = ?`, values);
    }
    if (patch.parts !== undefined) await replaceParts(conn, id, patch.parts);
    if (patch.promotions !== undefined) await replacePromotions(conn, id, patch.promotions);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getModelById(id);
}

export async function deleteModel(id: string): Promise<boolean> {
  const [result] = await pool.query(`DELETE FROM vehicle_models WHERE id = ?`, [id]);
  return (result as { affectedRows: number }).affectedRows > 0;
}
