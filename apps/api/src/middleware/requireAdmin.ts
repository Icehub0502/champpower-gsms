import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from './requireAuth.js';

/** Must run after requireAuth. Reads the role from the verified JWT, not any request body field. */
export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.authUser?.role !== 'admin') {
    res.status(403).json({ error: 'admin_required' });
    return;
  }
  next();
}
