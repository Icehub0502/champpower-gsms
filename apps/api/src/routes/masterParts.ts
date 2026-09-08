import { Router } from 'express';
import { createMasterPart, deleteMasterPart, listMasterParts, updateMasterPart } from '../db/masterParts.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { emitAuthed } from '../lib/socket.js';

export const masterPartsRouter = Router();
masterPartsRouter.use(requireAuth);

masterPartsRouter.get('/', async (_req, res) => {
  try {
    res.json(await listMasterParts());
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

masterPartsRouter.post('/', async (req, res) => {
  const body = req.body as { name?: string; category?: string };
  if (!body.name || !body.category) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  try {
    const part = await createMasterPart({ name: body.name, category: body.category });
    emitAuthed('master-part:changed', { id: part.id, part });
    res.status(201).json(part);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

masterPartsRouter.patch('/:id', async (req, res) => {
  try {
    const part = await updateMasterPart(req.params.id!, req.body);
    if (!part) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    emitAuthed('master-part:changed', { id: part.id, part });
    res.json(part);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

masterPartsRouter.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await deleteMasterPart(req.params.id!);
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    emitAuthed('master-part:changed', { id: req.params.id, part: null });
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});
