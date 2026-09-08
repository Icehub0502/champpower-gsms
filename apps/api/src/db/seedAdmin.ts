/* eslint-disable no-console */
// One-off convenience script: creates the very first admin account so someone can log
// in and use POST /api/users for everyone after that (there is no self-serve signup).
// Usage: SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run seed:admin -w apps/api
import bcrypt from 'bcrypt';
import { pool } from './pool.js';
import { createUser, findUserByEmail } from './users.js';

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD env vars before running this script.');
    process.exitCode = 1;
    return;
  }
  const existing = await findUserByEmail(email);
  if (existing) {
    console.log(`User ${email} already exists — nothing to do.`);
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await createUser({ email, passwordHash, role: 'admin', name: 'Admin' });
  console.log(`Created admin user ${email}.`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
