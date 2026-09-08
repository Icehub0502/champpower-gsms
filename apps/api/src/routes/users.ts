import { Router } from 'express';
import bcrypt from 'bcrypt';
import { createUser, deleteUser, findUserByEmail, listUsers } from '../db/users.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

export const usersRouter = Router();

// Admin-only, matches "บัญชีผู้ใช้สร้างโดยผู้ดูแลระบบเท่านั้น" — no self-serve signup endpoint exists.
usersRouter.use(requireAuth, requireAdmin);

usersRouter.get('/', async (_req, res) => {
  try {
    res.json(await listUsers());
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

usersRouter.post('/', async (req, res) => {
  const { email, password, role, name } = req.body as {
    email?: string;
    password?: string;
    role?: 'admin' | 'staff';
    name?: string;
  };
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  if (role !== 'admin' && role !== 'staff') {
    res.status(400).json({ error: 'invalid_role' });
    return;
  }
  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: 'email_taken' });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser({ email, passwordHash, role, name });
    res.status(201).json(user);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

usersRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteUser(req.params.id!);
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});
