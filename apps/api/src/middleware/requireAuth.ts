import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type JwtPayload } from '../lib/jwt.js';

export interface AuthedRequest extends Request {
  authUser?: JwtPayload;
}

/**
 * Verifies the app-issued JWT from the Authorization: Bearer <token> header.
 * Role checks build on top of this (see requireAdmin) by reading authUser.role,
 * which comes from the signed token, never a client-supplied field.
 */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  try {
    req.authUser = verifyToken(match[1]!);
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}
