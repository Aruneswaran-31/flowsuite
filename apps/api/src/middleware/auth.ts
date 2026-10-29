import type { NextFunction, Response } from 'express';
import { verifyAccessToken } from '../services/security.js';
import type { AuthenticatedRequest } from '../db.js';

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
  try {
    (req as AuthenticatedRequest).auth = verifyAccessToken(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Your session has expired. Sign in again.' } });
  }
}

export function allowRoles(...roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!roles.includes(req.auth!.role)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Your role does not have permission to do this.' } });
    next();
  };
}
