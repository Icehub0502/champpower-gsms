// @gsms/contracts — the single source of request/response schemas shared by
// apps/api and apps/web (CLAUDE.md §2: "web must never declare API types of
// its own"). Grows one module at a time, alongside the endpoint that needs
// it — see queue.ts / bookings.ts / checkin.ts / files.ts for the WO-003
// slice. Do not add schemas here speculatively for phases that have not
// started.
//
// Wire convention: every field in this package is camelCase. The database is
// snake_case throughout (packages/db); the repository layer in apps/api is
// what maps one to the other. Nothing under packages/contracts should ever
// see a snake_case key — if one shows up here, the mapping was skipped
// somewhere upstream.

export * from './common.js';
export * from './auth.js';
export * from './queue.js';
export * from './bookings.js';
export * from './checkin.js';
export * from './files.js';
export * from './today.js';
export * from './jobDetail.js';
export * from './publicBoard.js';
export * from './catalog.js';
export * from './quotation.js';
export * from './billing.js';
export * from './errors.js';
