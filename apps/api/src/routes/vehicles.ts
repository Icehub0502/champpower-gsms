import { Router } from 'express';
import { createVehicle, listVehicles, updateVehicle } from '../db/vehicles.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { emitAuthed } from '../lib/socket.js';

export const vehiclesRouter = Router();
vehiclesRouter.use(requireAuth);

vehiclesRouter.get('/', async (req, res) => {
  const plate = typeof req.query.plate === 'string' ? req.query.plate : undefined;
  try {
    res.json(await listVehicles(plate));
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

vehiclesRouter.post('/', async (req, res) => {
  const body = req.body as {
    customerId?: string;
    plate?: string;
    province?: string;
    brand?: string;
    model?: string;
    year?: string;
    color?: string;
    mileage?: string;
  };
  if (!body.customerId || !body.plate || !body.brand || !body.model) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  try {
    const vehicle = await createVehicle({
      customerId: body.customerId,
      plate: body.plate,
      province: body.province,
      brand: body.brand,
      model: body.model,
      year: body.year,
      color: body.color,
      mileage: body.mileage,
    });
    emitAuthed('vehicle:changed', { id: vehicle.id, vehicle });
    res.status(201).json(vehicle);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});

vehiclesRouter.patch('/:id', async (req, res) => {
  try {
    const vehicle = await updateVehicle(req.params.id!, req.body);
    if (!vehicle) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    emitAuthed('vehicle:changed', { id: vehicle.id, vehicle });
    res.json(vehicle);
  } catch {
    res.status(500).json({ error: 'internal_error' });
  }
});
