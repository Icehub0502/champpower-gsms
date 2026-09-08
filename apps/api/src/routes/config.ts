import { Router } from 'express';
import { getConfig, updateConfig } from '../db/config.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { emitAuthed } from '../lib/socket.js';

export const configRouter = Router();
configRouter.use(requireAuth);

configRouter.get('/', async (_req, res) => {
  try {
    res.json(await getConfig());
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

configRouter.patch('/', requireAdmin, async (req, res) => {
  try {
    const config = await updateConfig(req.body);
    emitAuthed('config:changed', config);
    res.json(config);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});
