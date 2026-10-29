import { Router, type Response, type Request } from 'express';
import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma, type AuthenticatedRequest } from '../db.js';
import { allowRoles } from '../middleware/auth.js';
import { enforceLimit, requireEntitlement } from '../middleware/usage.js';
import { hashOpaqueToken } from '../services/security.js';
import { canUpdateTask } from '../services/authorization.js';

export const workspaceRouter = Router();
export const invitationRouter = Router();
const ownerAdmin = allowRoles('OWNER', 'ADMIN');
const managers = allowRoles('OWNER', 'ADMIN', 'MANAGER');
const teamReaders = allowRoles('OWNER', 'ADMIN', 'MANAGER');
const ownerOnly = allowRoles('OWNER');
const parsePage = (req: Request) => ({ page: Math.max(1, Number(req.query.page) || 1), pageSize: Math.min(100, Math.max(1, Number(req.query.pageSize) || 20)) });
const errorHandler = (error: unknown, res: Response) => {
  const item = error as Error & { status?: number; code?: string; issues?: unknown };
  if (item instanceof z.ZodError) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Check the submitted fields.', details: item.flatten() } });
  if (item.code === 'P2002') return res.status(409).json({ error: { code: 'DUPLICATE_RESOURCE', message: 'That record already exists.' } });
  return res.status(item.status ?? 500).json({ error: { code: item.code ?? 'INTERNAL_ERROR', message: item.status ? item.message : 'Something went wrong. Please try again.' } });
};
const audit = (req: AuthenticatedRequest, action: string, targetType: string, targetId: string | null, metadata: object = {}) => prisma.auditLog.create({ data: { organizationId: req.auth!.organizationId, actorId: req.auth!.userId, action, targetType, targetId, metadata: metadata as object, ipAddress: req.ip } });
const pageResponse = <T,>(data: T[], total: number, page: number, pageSize: number) => ({ data, pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) } });

workspaceRouter.get('/dashboard', async (req: AuthenticatedRequest, res, next) => {
  try {
    const orgId = req.auth!.organizationId;
    const month = new Date().toISOString().slice(0, 7);
    const [org, members, projects, tasks, customers, subscription, usage, recentAudit, trend] = await Promise.all([
      prisma.organization.findUnique({ where: { id: orgId }, select: { name: true, slug: true, createdAt: true } }),
      prisma.membership.count({ where: { organizationId: orgId } }),
      prisma.project.count({ where: { organizationId: orgId, status: { not: 'ARCHIVED' } } }),
      prisma.task.count({ where: { organizationId: orgId } }),
      prisma.customer.count({ where: { organizationId: orgId, status: 'active' } }),
      prisma.subscription.findUnique({ where: { organizationId: orgId }, include: { plan: true } }),
      prisma.apiUsage.findUnique({ where: { organizationId_month: { organizationId: orgId, month } } }),
      prisma.auditLog.findMany({ where: { organizationId: orgId }, include: { actor: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 6 }),
      prisma.task.groupBy({ by: ['status'], where: { organizationId: orgId }, _count: { _all: true } }),
    ]);
    if (!subscription || !org) return res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' } });
    res.json({ workspace: org, plan: { code: subscription.plan.code, name: subscription.plan.name, monthlyPrice: subscription.plan.monthlyPrice, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd, limits: { seats: subscription.plan.seatLimit, projects: subscription.plan.projectLimit, apiRequests: subscription.plan.apiRequestLimit }, entitlements: subscription.plan.entitlements }, usage: { seats: members, projects, apiRequests: usage?.count ?? 0 }, stats: { tasks, customers }, taskDistribution: trend.map((row) => ({ name: row.status.replace('_', ' '), value: row._count._all })), recentActivity: recentAudit });
  } catch (error) { next(error); }
});

workspaceRouter.get('/plans', async (_req, res, next) => {
  try { res.json({ data: await prisma.plan.findMany({ where: { active: true }, orderBy: { monthlyPrice: 'asc' }, select: { code: true, name: true, monthlyPrice: true, seatLimit: true, projectLimit: true, apiRequestLimit: true, entitlements: true } }) }); }
  catch (error) { next(error); }
});

workspaceRouter.get('/members', teamReaders, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { page, pageSize } = parsePage(req);
    const where = { organizationId: req.auth!.organizationId };
    const [rows, total, invites] = await Promise.all([
      prisma.membership.findMany({ where, include: { user: { select: { id: true, name: true, email: true, createdAt: true } } }, orderBy: { joinedAt: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.membership.count({ where }),
      req.auth!.role === 'OWNER' || req.auth!.role === 'ADMIN'
        ? prisma.invitation.findMany({ where: { organizationId: req.auth!.organizationId, acceptedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, role: true, expiresAt: true, createdAt: true } })
        : Promise.resolve([]),
    ]);
    res.json({ ...pageResponse(rows, total, page, pageSize), invitations: req.auth!.role === 'OWNER' || req.auth!.role === 'ADMIN' ? invites : [] });
  } catch (error) { next(error); }
});

workspaceRouter.post('/members/invitations', ownerAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { email, role } = z.object({ email: z.string().email(), role: z.enum(['ADMIN', 'MANAGER', 'MEMBER']).default('MEMBER') }).parse(req.body);
    const normalizedEmail = email.toLowerCase().trim();
    if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) return res.status(409).json({ error: { code: 'USER_ALREADY_REGISTERED', message: 'That person already has a FlowSuite account.' } });
    await enforceLimit(req.auth!.organizationId, 'seats');
    const token = randomBytes(32).toString('base64url');
    const invite = await prisma.invitation.upsert({ where: { organizationId_email: { organizationId: req.auth!.organizationId, email: normalizedEmail } }, update: { role, tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), acceptedAt: null }, create: { organizationId: req.auth!.organizationId, email: normalizedEmail, role, tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } });
    await audit(req, 'member.invited', 'invitation', invite.id, { email: normalizedEmail, role });
    res.status(201).json({ data: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt }, ...(process.env.NODE_ENV !== 'production' ? { developmentInviteToken: token } : {}) });
  } catch (error) { errorHandler(error, res); }
});

invitationRouter.post('/', async (req, res, next) => {
  try {
    const { name, password, token } = z.object({ name: z.string().trim().min(2).max(100), password: z.string().min(10).max(128), token: z.string().min(32) }).parse(req.body);
    const invite = await prisma.invitation.findUnique({ where: { tokenHash: hashOpaqueToken(token) }, include: { organization: true } });
    if (!invite || invite.acceptedAt || invite.expiresAt <= new Date()) return res.status(400).json({ error: { code: 'INVITATION_INVALID', message: 'This invitation has expired or already been used.' } });
    const { hashPassword, accessTokenFor, issueRefreshToken } = await import('../services/security.js');
    const created = await prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email: invite.email } })) throw Object.assign(new Error('That email already has an account.'), { status: 409, code: 'USER_ALREADY_REGISTERED' });
      const user = await tx.user.create({ data: { name, email: invite.email, passwordHash: await hashPassword(password) } });
      await tx.membership.create({ data: { organizationId: invite.organizationId, userId: user.id, role: invite.role } });
      await tx.invitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      await tx.auditLog.create({ data: { organizationId: invite.organizationId, actorId: user.id, action: 'member.joined', targetType: 'membership', targetId: user.id, metadata: { role: invite.role } } });
      return { user, organization: invite.organization, role: invite.role };
    });
    const userContext = { userId: created.user.id, name: created.user.name, email: created.user.email, organizationId: invite.organizationId, organizationName: created.organization.name, role: created.role };
    const refresh = await issueRefreshToken(created.user.id);
    res.cookie('flowsuite_refresh', refresh, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api/auth', maxAge: 30 * 24 * 60 * 60 * 1000 }).status(201).json({ accessToken: accessTokenFor(userContext), user: userContext });
  } catch (error) { errorHandler(error, res); }
});

workspaceRouter.patch('/members/:id/role', ownerOnly, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { role } = z.object({ role: z.enum(['ADMIN', 'MANAGER', 'MEMBER']) }).parse(req.body);
    const member = await prisma.membership.findFirst({ where: { id: req.params.id, organizationId: req.auth!.organizationId }, include: { user: { select: { name: true, email: true } } } });
    if (!member) return res.status(404).json({ error: { code: 'MEMBER_NOT_FOUND', message: 'Member not found.' } });
    const previousRole = member.role;
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.membership.update({ where: { id: member.id }, data: { role } });
      await tx.auditLog.create({ data: { organizationId: req.auth!.organizationId, actorId: req.auth!.userId, action: 'member.role_changed', targetType: 'membership', targetId: member.id, metadata: { email: member.user.email, previousRole, role } } });
      return result;
    });
    res.json({ data: updated });
  } catch (error) { errorHandler(error, res); }
});

workspaceRouter.delete('/members/:id', ownerOnly, async (req: AuthenticatedRequest, res, next) => {
  try {
    const member = await prisma.membership.findFirst({ where: { id: req.params.id, organizationId: req.auth!.organizationId }, include: { user: { select: { email: true } } } });
    if (!member) return res.status(404).json({ error: { code: 'MEMBER_NOT_FOUND', message: 'Member not found.' } });
    if (member.role === 'OWNER') return res.status(403).json({ error: { code: 'OWNER_CANNOT_BE_REMOVED', message: 'Transfer ownership before removing the Owner.' } });
    await prisma.$transaction(async (tx) => {
      await tx.auditLog.create({ data: { organizationId: req.auth!.organizationId, actorId: req.auth!.userId, action: 'member.removed', targetType: 'membership', targetId: member.id, metadata: { email: member.user.email, role: member.role } } });
      await tx.membership.delete({ where: { id: member.id } });
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

workspaceRouter.get('/projects', async (req: AuthenticatedRequest, res, next) => {
  try {
    const { page, pageSize } = parsePage(req);
    const accessFilter = req.auth!.role === 'MEMBER' ? { tasks: { some: { assigneeId: req.auth!.userId } } } : {};
    const where = { organizationId: req.auth!.organizationId, status: { not: 'ARCHIVED' as const }, ...accessFilter };
    const [rows, total] = await Promise.all([
      prisma.project.findMany({ where, include: { customer: { select: { id: true, name: true, company: true } }, tasks: { where: { organizationId: req.auth!.organizationId }, include: { assignee: { select: { id: true, name: true } } }, orderBy: { updatedAt: 'desc' } }, _count: { select: { tasks: true } } }, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.project.count({ where }),
    ]);
    res.json(pageResponse(rows, total, page, pageSize));
  } catch (error) { next(error); }
});

workspaceRouter.post('/projects', managers, async (req: AuthenticatedRequest, res, next) => {
  try {
    const data = z.object({ name: z.string().trim().min(2).max(120), description: z.string().max(2000).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), customerId: z.string().nullable().optional() }).parse(req.body);
    await enforceLimit(req.auth!.organizationId, 'projects');
    if (data.customerId && !await prisma.customer.findFirst({ where: { id: data.customerId, organizationId: req.auth!.organizationId } })) return res.status(404).json({ error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found in this workspace.' } });
    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({ data: { ...data, organizationId: req.auth!.organizationId } });
      await tx.auditLog.create({ data: { organizationId: req.auth!.organizationId, actorId: req.auth!.userId, action: 'project.created', targetType: 'project', targetId: created.id, metadata: { name: created.name } } });
      return created;
    });
    res.status(201).json({ data: project });
  } catch (error) { errorHandler(error, res); }
});

workspaceRouter.patch('/projects/:id', managers, async (req: AuthenticatedRequest, res, next) => {
  try {
    const data = z.object({ name: z.string().trim().min(2).max(120).optional(), description: z.string().max(2000).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), status: z.enum(['ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).optional(), customerId: z.string().nullable().optional() }).parse(req.body);
    if (data.customerId && !await prisma.customer.findFirst({ where: { id: data.customerId, organizationId: req.auth!.organizationId } })) return res.status(404).json({ error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found in this workspace.' } });
    const result = await prisma.project.updateMany({ where: { id: req.params.id, organizationId: req.auth!.organizationId }, data });
    if (!result.count) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found.' } });
    const project = await prisma.project.findFirst({ where: { id: req.params.id, organizationId: req.auth!.organizationId } });
    if (data.status === 'ARCHIVED') await audit(req, 'project.archived', 'project', req.params.id, { name: project?.name });
    res.json({ data: project });
  } catch (error) { errorHandler(error, res); }
});

workspaceRouter.get('/tasks', async (req: AuthenticatedRequest, res, next) => {
  try {
    const { page, pageSize } = parsePage(req);
    const where = { organizationId: req.auth!.organizationId, ...(req.auth!.role === 'MEMBER' ? { assigneeId: req.auth!.userId } : {}), ...(req.query.projectId ? { projectId: String(req.query.projectId) } : {}), ...(req.query.status ? { status: String(req.query.status) as 'TODO' | 'IN_PROGRESS' | 'DONE' } : {}) };
    const [rows, total] = await Promise.all([
      prisma.task.findMany({ where, include: { assignee: { select: { id: true, name: true } }, project: { select: { id: true, name: true, color: true } } }, orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
      prisma.task.count({ where }),
    ]);
    res.json(pageResponse(rows, total, page, pageSize));
  } catch (error) { next(error); }
});

workspaceRouter.post('/projects/:projectId/tasks', managers, async (req: AuthenticatedRequest, res, next) => {
  try {
    const data = z.object({ title: z.string().trim().min(2).max(200), description: z.string().max(2000).optional(), assigneeId: z.string().nullable().optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'), dueDate: z.string().datetime().nullable().optional() }).parse(req.body);
    const project = await prisma.project.findFirst({ where: { id: req.params.projectId, organizationId: req.auth!.organizationId, status: { not: 'ARCHIVED' } } });
    if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found.' } });
    if (data.assigneeId && !await prisma.membership.findFirst({ where: { organizationId: req.auth!.organizationId, userId: data.assigneeId } })) return res.status(400).json({ error: { code: 'INVALID_ASSIGNEE', message: 'Choose a member of this workspace.' } });
    const task = await prisma.task.create({ data: { ...data, dueDate: data.dueDate ? new Date(data.dueDate) : null, organizationId: req.auth!.organizationId, projectId: project.id, creatorId: req.auth!.userId } });
    res.status(201).json({ data: task });
  } catch (error) { errorHandler(error, res); }
});

workspaceRouter.patch('/tasks/:id/status', async (req: AuthenticatedRequest, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']) }).parse(req.body);
    const task = await prisma.task.findFirst({ where: { id: req.params.id, organizationId: req.auth!.organizationId } });
    if (!task) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found.' } });
    if (!canUpdateTask(req.auth!.role, req.auth!.userId, task.assigneeId)) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only update tasks assigned to you.' } });
    const updated = await prisma.task.update({ where: { id: task.id }, data: { status } });
    res.json({ data: updated });
  } catch (error) { errorHandler(error, res); }
});

workspaceRouter.get('/customers', async (req: AuthenticatedRequest, res, next) => {
  try {
    const { page, pageSize } = parsePage(req);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const where = { organizationId: req.auth!.organizationId, status: 'active', ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { company: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] } : {}) };
    const [rows, total] = await Promise.all([
      prisma.customer.findMany({ where, include: { _count: { select: { projects: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.customer.count({ where }),
    ]);
    res.json(pageResponse(rows, total, page, pageSize));
  } catch (error) { next(error); }
});

workspaceRouter.post('/customers', managers, async (req: AuthenticatedRequest, res, next) => {
  try {
    const data = z.object({ name: z.string().trim().min(2).max(120), company: z.string().max(120).optional(), email: z.string().email().optional().or(z.literal('')), phone: z.string().max(40).optional() }).parse(req.body);
    const customer = await prisma.customer.create({ data: { ...data, organizationId: req.auth!.organizationId } });
    res.status(201).json({ data: customer });
  } catch (error) { errorHandler(error, res); }
});

workspaceRouter.patch('/customers/:id', managers, async (req: AuthenticatedRequest, res, next) => {
  try {
    const data = z.object({ name: z.string().trim().min(2).max(120).optional(), company: z.string().max(120).optional(), email: z.string().email().optional().or(z.literal('')), phone: z.string().max(40).optional(), status: z.enum(['active', 'archived']).optional() }).parse(req.body);
    const result = await prisma.customer.updateMany({ where: { id: req.params.id, organizationId: req.auth!.organizationId }, data });
    if (!result.count) return res.status(404).json({ error: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' } });
    res.json({ data: await prisma.customer.findFirst({ where: { id: req.params.id, organizationId: req.auth!.organizationId } }) });
  } catch (error) { errorHandler(error, res); }
});

workspaceRouter.get('/audit', ownerAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { page, pageSize } = parsePage(req);
    const where = { organizationId: req.auth!.organizationId, ...(typeof req.query.action === 'string' ? { action: { contains: req.query.action, mode: 'insensitive' as const } } : {}) };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, include: { actor: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.auditLog.count({ where }),
    ]);
    res.json(pageResponse(rows, total, page, pageSize));
  } catch (error) { next(error); }
});

workspaceRouter.get('/usage', ownerAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { page, pageSize } = parsePage(req);
    const subscription = await prisma.subscription.findUnique({ where: { organizationId: req.auth!.organizationId }, include: { plan: true } });
    if (!subscription) return res.status(404).json({ error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found.' } });
    const month = new Date().toISOString().slice(0, 7);
    const [seats, projects, api] = await Promise.all([
      prisma.membership.count({ where: { organizationId: req.auth!.organizationId } }),
      prisma.project.count({ where: { organizationId: req.auth!.organizationId, status: { not: 'ARCHIVED' } } }),
      prisma.apiUsage.findUnique({ where: { organizationId_month: { organizationId: req.auth!.organizationId, month } } }),
    ]);
    res.json({ plan: { ...subscription.plan, entitlements: subscription.plan.entitlements }, subscriptionStatus: subscription.status, used: { seats, projects, apiRequests: api?.count ?? 0 }, limits: { seats: subscription.plan.seatLimit, projects: subscription.plan.projectLimit, apiRequests: subscription.plan.apiRequestLimit } });
  } catch (error) { next(error); }
});

workspaceRouter.get('/analytics', ownerAdmin, requireEntitlement('advancedAnalytics'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const orgId = req.auth!.organizationId;
    const [byStatus, totalCustomers, activeProjects] = await Promise.all([
      prisma.task.groupBy({ by: ['status'], where: { organizationId: orgId }, _count: { _all: true } }),
      prisma.customer.count({ where: { organizationId: orgId, status: 'active' } }),
      prisma.project.count({ where: { organizationId: orgId, status: 'ACTIVE' } }),
    ]);
    res.json({ tasksByStatus: byStatus.map((item) => ({ status: item.status, count: item._count._all })), totalCustomers, activeProjects });
  } catch (error) { next(error); }
});

workspaceRouter.get('/billing/history', ownerOnly, async (req: AuthenticatedRequest, res, next) => {
  try {
    const subscription = await prisma.subscription.findUnique({ where: { organizationId: req.auth!.organizationId } });
    if (!subscription?.stripeCustomerId || !process.env.STRIPE_SECRET_KEY) return res.json({ data: [], message: 'Billing history will appear after your first test-mode checkout.' });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const invoices = await stripe.invoices.list({ customer: subscription.stripeCustomerId, limit: 25 });
    res.json({ data: invoices.data.map((invoice) => ({ id: invoice.id, number: invoice.number, status: invoice.status, currency: invoice.currency, amountPaid: invoice.amount_paid, created: invoice.created, hostedInvoiceUrl: invoice.hosted_invoice_url })) });
  } catch (error) { next(error); }
});

workspaceRouter.post('/billing/checkout', ownerOnly, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { planCode } = z.object({ planCode: z.enum(['STARTER', 'PROFESSIONAL']) }).parse(req.body);
    const plan = await prisma.plan.findUnique({ where: { code: planCode, active: true } });
    if (!plan) return res.status(404).json({ error: { code: 'PLAN_NOT_FOUND', message: 'That plan is currently unavailable.' } });
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_STARTER || !process.env.STRIPE_PRICE_PROFESSIONAL) return res.status(503).json({ error: { code: 'BILLING_NOT_CONFIGURED', message: 'Configure Stripe test-mode secret and price IDs to enable checkout.' } });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const existing = await prisma.subscription.findUnique({ where: { organizationId: req.auth!.organizationId } });
    const customer = existing?.stripeCustomerId ? { id: existing.stripeCustomerId } : await stripe.customers.create({ email: req.auth!.email, name: req.auth!.organizationName, metadata: { organizationId: req.auth!.organizationId } });
    if (!existing?.stripeCustomerId) await prisma.subscription.update({ where: { organizationId: req.auth!.organizationId }, data: { stripeCustomerId: customer.id } });
    const session = await stripe.checkout.sessions.create({ mode: 'subscription', customer: customer.id, line_items: [{ price: planCode === 'STARTER' ? process.env.STRIPE_PRICE_STARTER : process.env.STRIPE_PRICE_PROFESSIONAL, quantity: 1 }], success_url: `${process.env.APP_URL ?? 'http://localhost:5173'}/billing?success=1`, cancel_url: `${process.env.APP_URL ?? 'http://localhost:5173'}/billing?cancelled=1`, metadata: { organizationId: req.auth!.organizationId, planCode }, subscription_data: { metadata: { organizationId: req.auth!.organizationId, planCode } } });
    res.json({ url: session.url });
  } catch (error) { next(error); }
});

workspaceRouter.post('/billing/cancel', ownerOnly, async (req: AuthenticatedRequest, res, next) => {
  try {
    const subscription = await prisma.subscription.findUnique({ where: { organizationId: req.auth!.organizationId } });
    if (!subscription?.stripeSubscriptionId || !process.env.STRIPE_SECRET_KEY) return res.status(400).json({ error: { code: 'ACTIVE_SUBSCRIPTION_NOT_FOUND', message: 'No paid subscription is available to cancel.' } });
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, { cancel_at_period_end: true });
    await prisma.$transaction([
      prisma.subscription.update({ where: { organizationId: req.auth!.organizationId }, data: { status: 'CANCELLED' } }),
      prisma.auditLog.create({ data: { organizationId: req.auth!.organizationId, actorId: req.auth!.userId, action: 'subscription.cancelled', targetType: 'subscription', targetId: subscription.id } }),
    ]);
    res.json({ message: 'Subscription cancelled at the end of this billing period.' });
  } catch (error) { next(error); }
});

export async function stripeWebhook(req: Request, res: Response) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: { code: 'BILLING_NOT_CONFIGURED', message: 'Stripe webhook is not configured.' } });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event: Stripe.Event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] ?? '', secret); }
  catch { return res.status(400).json({ error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Webhook signature verification failed.' } }); }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const organizationId = session.metadata?.organizationId;
      const planCode = session.metadata?.planCode;
      if (organizationId && planCode && session.subscription) {
        const plan = await prisma.plan.findUnique({ where: { code: planCode } });
        if (plan) await prisma.$transaction(async (tx) => {
          await tx.subscription.update({ where: { organizationId }, data: { planId: plan.id, status: 'ACTIVE', stripeCustomerId: String(session.customer), stripeSubscriptionId: String(session.subscription), currentPeriodEnd: null } });
          await tx.auditLog.create({ data: { organizationId, action: 'subscription.plan_changed', targetType: 'subscription', metadata: { plan: planCode } } });
        });
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const stripeSub = event.data.object as Stripe.Subscription;
      const organizationId = stripeSub.metadata.organizationId;
      const planCode = stripeSub.metadata.planCode;
      if (organizationId) {
        const status = event.type === 'customer.subscription.deleted' ? 'EXPIRED' : stripeSub.status === 'past_due' ? 'PAST_DUE' : stripeSub.cancel_at_period_end ? 'CANCELLED' : 'ACTIVE';
        const plan = planCode ? await prisma.plan.findUnique({ where: { code: planCode } }) : null;
        if (plan && status !== 'EXPIRED') await prisma.subscription.update({ where: { organizationId }, data: { status, planId: plan.id, currentPeriodEnd: stripeSub.cancel_at ? new Date(stripeSub.cancel_at * 1000) : null } });
        else if (status === 'EXPIRED') {
          const free = await prisma.plan.findUnique({ where: { code: 'FREE' } });
          if (free) await prisma.subscription.update({ where: { organizationId }, data: { status, planId: free.id, stripeSubscriptionId: null } });
        }
      }
    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.customer) await prisma.subscription.updateMany({ where: { stripeCustomerId: String(invoice.customer) }, data: { status: 'PAST_DUE' } });
    } else if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.customer) await prisma.subscription.updateMany({ where: { stripeCustomerId: String(invoice.customer), status: 'PAST_DUE' }, data: { status: 'ACTIVE' } });
    }
    res.json({ received: true });
  } catch (error) { console.error('Stripe webhook processing error:', error); res.status(500).json({ error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Webhook event could not be processed.' } }); }
}
