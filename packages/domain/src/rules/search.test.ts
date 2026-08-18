import { describe, expect, it } from 'vitest';
import { jobSearchBlob, matchesSearch } from './search.js';

describe('jobSearchBlob', () => {
  const job = { jobNumber: 'PG260818-001', bay: 'H3', technician: 'ช่างเอ' };
  const vehicle = { plate: '6กข 3896', province: 'กรุงเทพ', brand: 'HONDA', model: 'CIVIC', color: 'ขาว' };
  const customer = { name: 'สมชาย', phone: '0812345678' };

  it('includes a spaceless copy of the plate so "6กข3896" matches too', () => {
    const blob = jobSearchBlob(job, vehicle, customer);
    expect(blob).toContain('6กข 3896');
    expect(blob).toContain('6กข3896');
  });

  it('is lowercase and includes model/brand/customer', () => {
    const blob = jobSearchBlob(job, vehicle, customer);
    expect(blob).toContain('civic');
    expect(blob).toContain('honda');
    expect(blob).toContain('สมชาย');
  });
});

describe('matchesSearch', () => {
  it('matches regardless of term order', () => {
    const blob = 'honda ขาว civic';
    expect(matchesSearch(blob, 'honda ขาว')).toBe(true);
    expect(matchesSearch(blob, 'ขาว honda')).toBe(true);
  });

  it('requires every term to be present', () => {
    expect(matchesSearch('honda civic', 'honda toyota')).toBe(false);
  });

  it('empty query matches everything', () => {
    expect(matchesSearch('anything', '')).toBe(true);
  });
});
