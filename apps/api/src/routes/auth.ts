import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { accessTokenFor, hashOpaqueToken, hashPassword, issueRefreshToken, verifyPassword } from '../services/security.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();
const credentials = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(128) });
const refreshCookie = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/api/auth', maxAge: 30 * 24 * 60 * 60 * 1000 };
const emailSafe = (email: string) => email.trim().toLowerCase();

function workspaceContext(user: { id: string; name: string; email: string; membership: { organizationId: string; role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER'; organization: { name: string } } | null }) {
  if (!user.membership) throw new Error('A workspace membership is required to create a session.');
  return { userId: user.id, name: user.name, email: user.email, organizationId: user.membership.organizationId, organizationName: user.membership.organization.name, role: user.membership.role };
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(2).max(100), organizationName: z.string().trim().min(2).max(100).optional() }).merge(credentials).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a name, valid email and password with at least 10 characters.' } });
    const { name, organizationName } = parsed.data;
    const email = emailSafe(parsed.data.email);
    if (await prisma.user.findUnique({ where: { email } })) return res.status(409).json({ error: { code: 'EMAIL_IN_USE', message: 'An account with this email already exists.' } });
    const slug = `${(organizationName ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${randomBytes(3).toString('hex')}`;
    const freePlan = await prisma.plan.findUnique({ where: { code: 'FREE' } });
    if (!freePlan) return res.status(503).json({ error: { code: 'PLANS_NOT_CONFIGURED', message: 'Plan configuration is unavailable. Run the database seed command.' } });
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { name, email, passwordHash: await hashPassword(parsed.data.password) } });
      const org = await tx.organization.create({ data: { name: organizationName ?? `${name}'s workspace`, slug } });
      await tx.membership.create({ data: { organizationId: org.id, userId: user.id, role: 'OWNER' } });
      await tx.subscription.create({ data: { organizationId: org.id, planId: freePlan.id } });
      await tx.auditLog.create({ data: { organizationId: org.id, actorId: user.id, action: 'organization.created', targetType: 'organization', targetId: org.id, metadata: { plan: 'FREE' } } });
      return { ...user, membership: { organizationId: org.id, role: 'OWNER' as const, organization: { name: org.name } } };
    });
    const userContext = workspaceContext(result);
    const refreshToken = await issueRefreshToken(result.id);
    res.cookie('flowsuite_refresh', refreshToken, refreshCookie).status(201).json({ accessToken: accessTokenFor(userContext), user: userContext });
  } catch (error) { next(error); }
});

const failedLogins = new Map<string, { count: number; resetAt: number }>();
authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email and password.' } });
    const email = emailSafe(parsed.data.email);
    const failures = failedLogins.get(email);
    if (failures && failures.resetAt > Date.now() && failures.count >= 8) return res.status(429).json({ error: { code: 'LOGIN_RATE_LIMITED', message: 'Too many attempts. Try again in 15 minutes.' } });
    const user = await prisma.user.findUnique({ where: { email }, include: { membership: { include: { organization: true } } } });
    if (!user || !await verifyPassword(parsed.data.password, user.passwordHash) || !user.membership) {
      const nextFailures = failures && failures.resetAt > Date.now() ? failures : { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
      nextFailures.count++;
      failedLogins.set(email, nextFailures);
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' } });
    }
    failedLogins.delete(email);
    const userContext = workspaceContext(user);
    const refreshToken = await issueRefreshToken(user.id);
    res.cookie('flowsuite_refresh', refreshToken, refreshCookie).json({ accessToken: accessTokenFor(userContext), user: userContext });
  } catch (error) { next(error); }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.flowsuite_refresh;
    if (!rawToken) return res.status(401).json({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'Sign in to continue.' } });
    const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hashOpaqueToken(rawToken) }, include: { user: { include: { membership: { include: { organization: true } } } } } });
    if (!record || record.revokedAt || record.expiresAt <= new Date() || !record.user.membership) return res.status(401).json({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'Your session has expired. Sign in again.' } });
    const rotated = await prisma.$transaction(async (tx) => {
      await tx.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
      const token = randomBytes(48).toString('base64url');
      await tx.refreshToken.create({ data: { userId: record.userId, tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
      return token;
    });
    res.cookie('flowsuite_refresh', rotated, refreshCookie).json({ accessToken: accessTokenFor(workspaceContext(record.user)), user: workspaceContext(record.user) });
  } catch (error) { next(error); }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.flowsuite_refresh;
    if (rawToken) await prisma.refreshToken.updateMany({ where: { tokenHash: hashOpaqueToken(rawToken), revokedAt: null }, data: { revokedAt: new Date() } });
    res.clearCookie('flowsuite_refresh', { path: '/api/auth' }).json({ message: 'Signed out.' });
  } catch (error) { next(error); }
});

authRouter.post('/password/reset-request', async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter a valid email address.' } });
    const user = await prisma.user.findUnique({ where: { email: emailSafe(parsed.data.email) } });
    let developmentResetToken: string | undefined;
    if (user) {
      const token = randomBytes(32).toString('base64url');
      await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
      if (process.env.NODE_ENV !== 'production') developmentResetToken = token;
    }
    res.json({ message: 'If that email is registered, a password reset link will be sent shortly.', ...(developmentResetToken ? { developmentResetToken } : {}) });
  } catch (error) { next(error); }
});

authRouter.post('/password/reset', async (req, res, next) => {
  try {
    const parsed = z.object({ token: z.string().min(32), password: z.string().min(10).max(128) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Use a valid reset link and a password of at least 10 characters.' } });
    const reset = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashOpaqueToken(parsed.data.token) } });
    if (!reset || reset.usedAt || reset.expiresAt <= new Date()) return res.status(400).json({ error: { code: 'RESET_TOKEN_INVALID', message: 'This reset link is invalid or expired.' } });
    const passwordHash = await hashPassword(parsed.data.password);
    await prisma.$transaction([
      prisma.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
      prisma.refreshToken.updateMany({ where: { userId: reset.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    res.json({ message: 'Password updated. Sign in with your new password.' });
  } catch (error) { next(error); }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, name: true, email: true, createdAt: true } });
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    res.json({ user: { ...req.auth, ...user } });
  } catch (error) { next(error); }
});
