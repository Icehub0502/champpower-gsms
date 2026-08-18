export const PART_CATEGORIES = ['ทั่วไป', 'โช๊คอัพ', 'ผ้าเบรค', 'เพลาขับ', 'ของเหลว'] as const;
export const FALLBACK_CATEGORY = 'อื่นๆ';

export const UNIT_OPTIONS = ['ชิ้น', 'เส้น', 'อัน', 'คู่', 'ลิตร', 'ชุด', 'ใบ', 'ครั้ง', 'ข้าง'];

export const DEFAULT_PART_BRANDS = ['รีบิ้ว', 'OEM', 'POWERED'];

export interface MasterPartSeed {
  name: string;
  category: string;
}

export const DEFAULT_MASTER_PARTS: MasterPartSeed[] = [
  { name: 'แร็คพวงมาลัย', category: 'ทั่วไป' },
  { name: 'ลูกหมากคันชัก', category: 'ทั่วไป' },
  { name: 'ลูกหมากกันโคลง', category: 'ทั่วไป' },
  { name: 'ยางกันโคลง', category: 'ทั่วไป' },
  { name: 'ลูกหมากปีกนก ล่าง', category: 'ทั่วไป' },
  { name: 'ลูกหมากปีกนก บน', category: 'ทั่วไป' },
  { name: 'ปีกนก ล่าง', category: 'ทั่วไป' },
  { name: 'ปีกนก บน', category: 'ทั่วไป' },
  { name: 'โช้คอัพ หน้า', category: 'โช๊คอัพ' },
  { name: 'เบ้าโช้คอัพ หน้า', category: 'โช๊คอัพ' },
  { name: 'อุปกรณ์โช้ค หน้า', category: 'โช๊คอัพ' },
  { name: 'โช้คอัพ หลัง', category: 'โช๊คอัพ' },
  { name: 'เบ้าโช้คอัพ หลัง', category: 'โช๊คอัพ' },
  { name: 'อุปกรณ์โช้ค หลัง', category: 'โช๊คอัพ' },
  { name: 'เบ้าโช๊คหน้า', category: 'โช๊คอัพ' },
  { name: 'กันฝุ่น', category: 'โช๊คอัพ' },
  { name: 'กันกระแทก หน้า', category: 'โช๊คอัพ' },
  { name: 'ลูกปืนเบ้าโช๊คหน้า', category: 'โช๊คอัพ' },
  { name: 'แผ่นเหล็กรองเบ้าโช๊ค', category: 'โช๊คอัพ' },
  { name: 'ผ้าเบรค หน้า', category: 'ผ้าเบรค' },
  { name: 'ผ้าเบรค หลัง', category: 'ผ้าเบรค' },
  { name: 'เพลาขับ', category: 'เพลาขับ' },
  { name: 'ยางหุ้มเพลาขับ', category: 'เพลาขับ' },
  { name: 'หัวเพลาขับ นอก', category: 'เพลาขับ' },
  { name: 'จารบีเพลาขับ', category: 'เพลาขับ' },
  { name: 'น้ำมันเครื่อง', category: 'ของเหลว' },
  { name: 'กรองน้ำมันเครื่อง', category: 'ของเหลว' },
  { name: 'น้ำมันเกียร์', category: 'ของเหลว' },
  { name: 'น้ำยาหม้อน้ำ', category: 'ของเหลว' },
  { name: 'น้ำมันเบรค', category: 'ของเหลว' },
];

export interface GroupedByCategory<T> {
  category: string;
  items: T[];
}

/**
 * Groups a flat list of {category, ...} items into [{category, items}], ordered by
 * PART_CATEGORIES with unrecognized categories bucketed at the end under
 * FALLBACK_CATEGORY so nothing is ever silently hidden.
 */
export function groupByCategory<T extends { category?: string }>(items: T[]): GroupedByCategory<T>[] {
  const order = [...PART_CATEGORIES, FALLBACK_CATEGORY];
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const cat = (PART_CATEGORIES as readonly string[]).includes(item.category ?? '')
      ? (item.category as string)
      : FALLBACK_CATEGORY;
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat)!.push(item);
  }
  return order.filter((cat) => buckets.has(cat)).map((cat) => ({ category: cat, items: buckets.get(cat)! }));
}
