import express from 'express';
import { healthRouter } from './routes/health.js';
import { aiRouter } from './routes/ai.js';

export const app = express();

app.use(express.json());
app.use('/health', healthRouter);
app.use('/ai', aiRouter);
