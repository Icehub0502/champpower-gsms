import type { ShopConfig, TechnicianEntry } from '@champpower/domain';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from './pool.js';
import { newId } from '../lib/ids.js';

interface ConfigRow {
  shop_name: string;
  shop_sub: string;
  shop_phone: string;
  shop_line: string;
  shop_site: string;
  ai_api_key: string | null;
  gemini_api_key: string | null;
  ai_model: 'claude' | 'gemini';
  theme_id: string;
}

export async function getConfig(): Promise<ShopConfig> {
  const [rows] = await pool.query(`SELECT * FROM shop_config WHERE id = 1`);
  const row = (rows as ConfigRow[])[0];
  const [techRows] = await pool.query(`SELECT id, name FROM technicians ORDER BY sort_order ASC`);
  const [deletedRows] = await pool.query(`SELECT name FROM deleted_master_part_names`);

  return {
    shop: {
      name: row?.shop_name || '',
      sub: row?.shop_sub || '',
      phone: row?.shop_phone || '',
      line: row?.shop_line || '',
      site: row?.shop_site || '',
    },
    settings: {
      aiApiKey: row?.ai_api_key || '',
      geminiApiKey: row?.gemini_api_key || '',
      aiModel: row?.ai_model || 'claude',
      themeId: row?.theme_id || 'default',
    },
    technicians: (techRows as TechnicianEntry[]).map((t) => ({ id: t.id, name: t.name })),
    deletedMasterPartNames: (deletedRows as { name: string }[]).map((r) => r.name),
  };
}

async function replaceTechnicians(conn: PoolConnection, technicians: TechnicianEntry[]): Promise<void> {
  await conn.query(`DELETE FROM technicians`);
  let order = 0;
  for (const t of technicians) {
    await conn.query(`INSERT INTO technicians (id, name, sort_order) VALUES (?, ?, ?)`, [t.id || newId(), t.name, order++]);
  }
}

async function replaceDeletedMasterPartNames(conn: PoolConnection, names: string[]): Promise<void> {
  await conn.query(`DELETE FROM deleted_master_part_names`);
  for (const name of names) {
    await conn.query(`INSERT IGNORE INTO deleted_master_part_names (id, name) VALUES (?, ?)`, [newId(), name]);
  }
}

export async function updateConfig(patch: Partial<ShopConfig>): Promise<ShopConfig> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.shop) {
      sets.push('shop_name = ?', 'shop_sub = ?', 'shop_phone = ?', 'shop_line = ?', 'shop_site = ?');
      values.push(patch.shop.name, patch.shop.sub, patch.shop.phone, patch.shop.line, patch.shop.site);
    }
    if (patch.settings) {
      sets.push('ai_api_key = ?', 'gemini_api_key = ?', 'ai_model = ?', 'theme_id = ?');
      values.push(patch.settings.aiApiKey || null, patch.settings.geminiApiKey || null, patch.settings.aiModel, patch.settings.themeId);
    }
    if (sets.length > 0) {
      await conn.query(`UPDATE shop_config SET ${sets.join(', ')} WHERE id = 1`, values);
    }
    if (patch.technicians !== undefined) await replaceTechnicians(conn, patch.technicians);
    if (patch.deletedMasterPartNames !== undefined) await replaceDeletedMasterPartNames(conn, patch.deletedMasterPartNames);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getConfig();
}
