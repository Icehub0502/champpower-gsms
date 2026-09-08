import { Router } from 'express';
import { createModel, deleteModel, getModelById, listModels, updateModel } from '../db/models.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { emitAuthed } from '../lib/socket.js';

export const modelsRouter = Router();
modelsRouter.use(requireAuth);

modelsRouter.get('/', async (_req, res) => {
  try {
    res.json(await listModels());
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

modelsRouter.get('/:id', async (req, res) => {
  try {
    const model = await getModelById(req.params.id!);
    if (!model) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(model);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

modelsRouter.post('/', async (req, res) => {
  const body = req.body as { brand?: string; name?: string };
  if (!body.brand || !body.name) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  try {
    const model = await createModel(req.body);
    emitAuthed('model:changed', { id: model.id, model });
    res.status(201).json(model);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

modelsRouter.patch('/:id', async (req, res) => {
  try {
    const model = await updateModel(req.params.id!, req.body);
    if (!model) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    emitAuthed('model:changed', { id: model.id, model });
    res.json(model);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

modelsRouter.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await deleteModel(req.params.id!);
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    emitAuthed('model:changed', { id: req.params.id, model: null });
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});
