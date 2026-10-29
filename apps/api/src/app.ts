import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth.js';
import { invitationRouter, stripeWebhook, workspaceRouter } from './routes/workspace.js';
import { requireAuth } from './middleware/auth.js';
import { trackApiUsage } from './middleware/usage.js';
import { prisma, type AuthenticatedRequest } from './db.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet());
app.use(cors({ origin: process.env.APP_URL ?? 'http://localhost:5173', credentials: true }));
app.get('/', (req, res) => {
  if (req.accepts(['json', 'html']) === 'html') return res.redirect(302, process.env.APP_URL ?? 'http://localhost:5173');
  res.json({ service: 'flowsuite-api', status: 'ok', webApp: process.env.APP_URL ?? 'http://localhost:5173', health: '/api/health' });
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'flowsuite-api' }));
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => void stripeWebhook(req, res));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false }), authRouter);
app.use('/api/workspace/members/invitations/accept', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), invitationRouter);
app.use('/api', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const member = await prisma.membership.findFirst({ where: { userId: req.auth!.userId, organizationId: req.auth!.organizationId, role: req.auth!.role }, select: { id: true } });
    if (!member) return res.status(401).json({ error: { code: 'MEMBERSHIP_REVOKED', message: 'Your workspace access has changed. Sign in again.' } });
    next();
  } catch (error) { next(error); }
});
app.use('/api/workspace', requireAuth, trackApiUsage, workspaceRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API endpoint not found.' } }));
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (process.env.NODE_ENV !== 'production') console.error(err);
  res.status(err.status ?? 500).json({ error: { code: err.status ? 'REQUEST_ERROR' : 'INTERNAL_ERROR', message: err.status ? err.message : 'Something went wrong. Please try again.' } });
});
