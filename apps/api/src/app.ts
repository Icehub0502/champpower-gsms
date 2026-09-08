import cors from 'cors';
import express from 'express';
import { healthRouter } from './routes/health.js';
import { aiRouter } from './routes/ai.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { jobsRouter } from './routes/jobs.js';
import { vehiclesRouter } from './routes/vehicles.js';
import { customersRouter } from './routes/customers.js';
import { modelsRouter } from './routes/models.js';
import { masterPartsRouter } from './routes/masterParts.js';
import { configRouter } from './routes/config.js';
import { publicRouter } from './routes/public.js';

export const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
// Base64 photos travel as plain JSON string fields, so allow a generous body size.
app.use(express.json({ limit: '25mb' }));

app.use('/health', healthRouter);
app.use('/api/ai', aiRouter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/vehicles', vehiclesRouter);
app.use('/api/customers', customersRouter);
app.use('/api/models', modelsRouter);
app.use('/api/master-parts', masterPartsRouter);
app.use('/api/config', configRouter);
app.use('/api/public', publicRouter);

// Never expose stack traces to the client (CLAUDE.md).
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});
