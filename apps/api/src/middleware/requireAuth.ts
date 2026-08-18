import type { NextFunction, Request, Response } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { adminAuth } from '../lib/admin.js';

export interface AuthedRequest extends Request {
  authUser?: DecodedIdToken;
}

/**
 * Verifies the Firebase ID token from the Authorization: Bearer <token> header.
 * Role checks build on top of this (see requireAdmin) by reading authUser.role —
 * the custom claim, never a client-supplied field.
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  try {
    req.authUser = await adminAuth.verifyIdToken(match[1]!);
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}
