import type { NextFunction, Response } from 'express';
import { prisma, type AuthenticatedRequest } from '../db.js';

export async function trackApiUsage(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const [subscription, usage] = await Promise.all([
      prisma.subscription.findUnique({ where: { organizationId: req.auth!.organizationId }, include: { plan: true } }),
      prisma.apiUsage.findUnique({ where: { organizationId_month: { organizationId: req.auth!.organizationId, month } } }),
    ]);
    if (!subscription) return res.status(402).json({ error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Choose a plan to continue.' } });
    if (usage && usage.count >= subscription.plan.apiRequestLimit) {
      return res.status(429).json({ error: { code: 'API_LIMIT_REACHED', message: `Your ${subscription.plan.name} plan includes ${subscription.plan.apiRequestLimit.toLocaleString()} API requests each month. Upgrade to continue.` } });
    }
    await prisma.apiUsage.upsert({ where: { organizationId_month: { organizationId: req.auth!.organizationId, month } }, update: { count: { increment: 1 } }, create: { organizationId: req.auth!.organizationId, month, count: 1 } });
    res.locals.plan = subscription.plan;
    next();
  } catch (error) { next(error); }
}

export function requireEntitlement(name: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const entitlements = res.locals.plan?.entitlements as Record<string, boolean> | undefined;
    if (entitlements?.[name]) return next();
    return res.status(403).json({ error: { code: 'ENTITLEMENT_REQUIRED', message: `${name} is available on the Professional plan. Upgrade your workspace to unlock it.` } });
  };
}

export async function enforceLimit(organizationId: string, resource: 'seats' | 'projects') {
  const subscription = await prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
  if (!subscription) throw Object.assign(new Error('Subscription not found.'), { status: 402, code: 'SUBSCRIPTION_REQUIRED' });
  const limit = resource === 'seats' ? subscription.plan.seatLimit : subscription.plan.projectLimit;
  if (limit < 0) return;
  const used = resource === 'seats'
    ? await prisma.membership.count({ where: { organizationId } }) + await prisma.invitation.count({ where: { organizationId, acceptedAt: null, expiresAt: { gt: new Date() } } })
    : await prisma.project.count({ where: { organizationId, status: { not: 'ARCHIVED' } } });
  if (used >= limit) throw Object.assign(new Error(`Your ${subscription.plan.name} plan allows ${limit} ${resource}. Upgrade your plan to add more.`), { status: 403, code: `${resource.toUpperCase()}_LIMIT_REACHED` });
}
