import { describe, expect, it } from 'vitest';
import { boardPayloadFor } from './board.js';
import type { Job } from '../types/job.js';
import type { Vehicle } from '../types/vehicle.js';

describe('boardPayloadFor', () => {
  it('never includes customer name, phone, or price', () => {
    const job = {
      id: 'j1', jobNumber: 'PG1', vehicleId: 'v1', customerId: 'c1', status: 'repairing',
      statusHistory: [], complaints: [], partsNeeded: [], createdAt: '2026-01-01T00:00:00Z',
      priceEstimate: 9999,
    } as unknown as Job;
    const vehicle = { id: 'v1', customerId: 'c1', plate: '1กก1', brand: 'TOYOTA', model: 'VIOS' } as Vehicle;
    const entry = boardPayloadFor(job, vehicle, '2026-01-02T00:00:00Z');
    expect(entry).not.toHaveProperty('name');
    expect(entry).not.toHaveProperty('phone');
    expect(entry).not.toHaveProperty('price');
    expect(entry.plate).toBe('1กก1');
  });

  it('falls back to empty strings when the vehicle is missing', () => {
    const job = {
      id: 'j1', jobNumber: 'PG1', vehicleId: 'missing', customerId: 'c1', status: 'received',
      statusHistory: [], complaints: [], partsNeeded: [], createdAt: '2026-01-01T00:00:00Z',
    } as unknown as Job;
    const entry = boardPayloadFor(job, undefined, '2026-01-02T00:00:00Z');
    expect(entry.plate).toBe('');
    expect(entry.brand).toBe('');
  });
});
