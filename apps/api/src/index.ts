import { createServer } from 'node:http';
import { app } from './app.js';
import { db } from './lib/db.js';
import { initSocket } from './lib/socket.js';
import { runStartupChecks } from './lib/startupChecks.js';

const port = Number(process.env.PORT) || 4000;

/**
 * Last-resort nets.
 *
 * Every async handler is wrapped (middleware/asyncHandler.ts), so nothing
 * should reach these. If something does, the process is in a state we did not
 * design for — exiting deliberately lets the supervisor restart it clean,
 * rather than serving requests from a process whose invariants may be broken.
 */
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('unhandled rejection; exiting', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('uncaught exception; exiting', err);
  process.exit(1);
});

async function main(): Promise<void> {
  // Before the port opens, not after: a process that has already accepted a
  // request as the wrong role has already leaked across shops, and one that
  // cannot sign a token fails at the counter instead of at deploy time.
  await runStartupChecks(db);

  const server = createServer(app);
  initSocket(server);

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`champpower-api listening on :${port}`);
  });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('startup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
