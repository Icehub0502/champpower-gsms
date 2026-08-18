import { describe, expect, it } from 'vitest';
import { dayScopedJobs, filterByStatus } from './jobListFilters.js';
import { todayKey } from '../utils/date.js';

describe('dayScopedJobs', () => {
  const jobs = [
    { id: '1', status: 'received' as const, createdAt: '2026-01-10T08:00:00Z', appointmentDate: null },
    { id: '2', status: 'delivered' as const, createdAt: '2026-01-10T09:00:00Z', appointmentDate: null },
    { id: '3', status: 'carout' as const, createdAt: '2026-01-10T09:00:00Z', appointmentDate: null }, // rejected dead end
    { id: '4', status: 'inspecting' as const, createdAt: '2026-01-11T08:00:00Z', appointmentDate: null },
    { id: '5', status: 'received' as const, createdAt: '2026-01-10T08:00:00Z', appointmentDate: null, deletedAt: '2026-01-12T00:00:00Z' },
  ];

  it('excludes delivered, rejected-carout, and deleted jobs', () => {
    const result = dayScopedJobs(jobs, { dayFilter: 'all' });
    expect(result.map((j) => j.id)).toEqual(['4', '1']); // newest first, 2/3/5 excluded
  });

  it('scopes to one day when a dayFilter is given', () => {
    const result = dayScopedJobs(jobs, { dayFilter: '2026-01-10' });
    expect(result.map((j) => j.id)).toEqual(['1']);
  });

  it('apptFilterOnly cuts across day boundaries for jobs with a due appointment', () => {
    const withAppt = [
      { id: 'a', status: 'carout' as const, createdAt: '2026-01-01T08:00:00Z', appointmentDate: todayKey() },
      { id: 'b', status: 'received' as const, createdAt: '2026-01-01T08:00:00Z', appointmentDate: null },
    ];
    const result = dayScopedJobs(withAppt, { dayFilter: 'all', apptFilterOnly: true });
    expect(result.map((j) => j.id)).toEqual(['a']);
  });
});

describe('filterByStatus', () => {
  it('passes everything through for "all"', () => {
    const jobs = [{ status: 'received' as const }, { status: 'quoted' as const }];
    expect(filterByStatus(jobs, 'all')).toHaveLength(2);
  });

  it('filters to one status otherwise', () => {
    const jobs = [{ status: 'received' as const }, { status: 'quoted' as const }];
    expect(filterByStatus(jobs, 'quoted')).toEqual([{ status: 'quoted' }]);
  });
});
