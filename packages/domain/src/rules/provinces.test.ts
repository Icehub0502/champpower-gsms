import { describe, expect, it } from 'vitest';
import {
  isPlateArea, isThaiProvince, normaliseProvince, PLATE_AREAS, THAI_PROVINCES,
} from './provinces.js';

describe('THAI_PROVINCES', () => {
  it('has exactly 77 entries', () => {
    expect(THAI_PROVINCES).toHaveLength(77);
  });

  it('has no duplicates', () => {
    expect(new Set(THAI_PROVINCES).size).toBe(THAI_PROVINCES.length);
  });

  it('names Bangkok officially, and includes the province this shop is in', () => {
    expect(THAI_PROVINCES).toContain('กรุงเทพมหานคร');
    expect(THAI_PROVINCES).toContain('สมุทรปราการ');
    expect(THAI_PROVINCES).toContain('บึงกาฬ'); // the newest province (2011)
  });

  it('holds only names with no stray whitespace', () => {
    for (const p of THAI_PROVINCES) expect(p, JSON.stringify(p)).toBe(p.trim());
  });
});

describe('isThaiProvince', () => {
  it('accepts an official name and refuses a variant', () => {
    expect(isThaiProvince('กรุงเทพมหานคร')).toBe(true);
    expect(isThaiProvince('กทม')).toBe(false);
    expect(isThaiProvince('เบตง')).toBe(false); // a plate area, not a province
    expect(isThaiProvince(42)).toBe(false);
  });
});

describe('PLATE_AREAS — what a plate carries (owner decision, 30 Sep 2026)', () => {
  it('is the 77 provinces plus เบตง: 78, no duplicates', () => {
    expect(PLATE_AREAS).toHaveLength(78);
    expect(new Set(PLATE_AREAS).size).toBe(78);
    for (const p of THAI_PROVINCES) expect(PLATE_AREAS).toContain(p);
    expect(PLATE_AREAS).toContain('เบตง');
  });

  it('keeps เบตง and ยะลา as two areas — a Betong plate is its own series', () => {
    expect(isPlateArea('เบตง')).toBe(true);
    expect(isPlateArea('ยะลา')).toBe(true);
    expect('เบตง').not.toBe('ยะลา');
    expect(isPlateArea('กทม')).toBe(false);
    expect(isPlateArea(null)).toBe(false);
  });
});

describe('normaliseProvince — for the WO-004 import, not the API', () => {
  it('maps the common Bangkok spellings to the official name', () => {
    for (const v of ['กทม', 'กทม.', 'กรุงเทพ', 'กรุงเทพฯ', 'Bangkok', ' กรุงเทพมหานคร ']) {
      expect(normaliseProvince(v), v).toBe('กรุงเทพมหานคร');
    }
  });

  it('strips a จังหวัด / จ. prefix', () => {
    expect(normaliseProvince('จังหวัดระยอง')).toBe('ระยอง');
    expect(normaliseProvince('จ.ชลบุรี')).toBe('ชลบุรี');
    expect(normaliseProvince('จ. นนทบุรี')).toBe('นนทบุรี');
  });

  it('maps the well-known short names', () => {
    expect(normaliseProvince('อยุธยา')).toBe('พระนครศรีอยุธยา');
    expect(normaliseProvince('โคราช')).toBe('นครราชสีมา');
  });

  it('maps every spelling of Betong to เบตง — never to ยะลา', () => {
    for (const v of ['เบตง', ' เบตง ', 'ป้ายเบตง', 'ป้าย เบตง', 'Betong', 'BETONG', 'be tong', 'จ.เบตง']) {
      expect(normaliseProvince(v), v).toBe('เบตง');
    }
    expect(normaliseProvince('ยะลา')).toBe('ยะลา');
  });

  it('returns null for anything it does not recognise — a person resolves it, nothing is guessed', () => {
    expect(normaliseProvince('ไม่รู้')).toBeNull();
    expect(normaliseProvince('')).toBeNull();
    expect(normaliseProvince(null)).toBeNull();
  });
});
