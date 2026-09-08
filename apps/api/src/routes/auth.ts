import { Router } from 'express';
import bcrypt from 'bcrypt';
import { findUserByEmail, findUserById } from '../db/users.js';
import { signToken } from '../lib/jwt.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    res.status(400).json({ error: 'missing_credentials' });
    return;
  }
  try {
    const user = await findUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    const token = signToken({ sub: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

authRouter.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const user = await findUserById(req.authUser!.sub);
    if (!user) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ id: user.id, email: user.email, role: user.role, name: user.name });
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});
