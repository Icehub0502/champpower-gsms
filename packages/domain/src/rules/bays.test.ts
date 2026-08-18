import { describe, expect, it } from 'vitest';
import { jobInBay } from './bays.js';

describe('jobInBay', () => {
  const jobs = [
    { id: 'j1', bay: 'H1', status: 'repairing' },
    { id: 'j2', bay: '', status: 'received' },
    { id: 'j3', bay: 'H3', status: 'delivered' },
  ];

  it('finds the job currently parked in a bay', () => {
    expect(jobInBay(jobs, 'H1')?.id).toBe('j1');
  });

  it('returns null for an empty bay', () => {
    expect(jobInBay(jobs, 'H2')).toBeNull();
  });

  it('excludes the given job id — a job never counts as blocking its own bay', () => {
    expect(jobInBay(jobs, 'H1', 'j1')).toBeNull();
  });

  it('a delivered job does not hold its bay, even if the field was never cleared', () => {
    expect(jobInBay(jobs, 'H3')).toBeNull();
  });
});
