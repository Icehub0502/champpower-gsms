import { Router } from 'express';
import { createCustomer, listCustomers, updateCustomer } from '../db/customers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { emitAuthed } from '../lib/socket.js';

export const customersRouter = Router();
customersRouter.use(requireAuth);

customersRouter.get('/', async (req, res) => {
  const phone = typeof req.query.phone === 'string' ? req.query.phone : undefined;
  try {
    res.json(await listCustomers(phone));
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

customersRouter.post('/', async (req, res) => {
  const body = req.body as { name?: string; phone?: string };
  try {
    const customer = await createCustomer(body);
    emitAuthed('customer:changed', { id: customer.id, customer });
    res.status(201).json(customer);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

customersRouter.patch('/:id', async (req, res) => {
  try {
    const customer = await updateCustomer(req.params.id!, req.body);
    if (!customer) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    emitAuthed('customer:changed', { id: customer.id, customer });
    res.json(customer);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});
