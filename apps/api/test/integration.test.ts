import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';

const PASSWORD = 'Password123';
const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

type Account = { token: string; user: { userId: string; organizationId: string; role: string; email: string } };
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const emails: string[] = [];
const mail = (local: string) => { const value = `${local}-${stamp}@integration.test`; emails.push(value); return value; };

async function registerUser(name: string, email: string, organizationName: string): Promise<Account> {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: PASSWORD, organizationName });
  expect(res.status).toBe(201);
  return { token: res.body.accessToken, user: res.body.user };
}

describe.runIf(dbAvailable)('FlowSuite API integration', () => {
  let owner: Account;
  let other: Account;
  let member: Account;
  let manager: Account;
  let inviteToken = '';
  let managerInviteToken = '';
  let projectOneId = '';
  let projectTwoId = '';
  let customerId = '';
  let assignedTaskId = '';
  let unassignedTaskId = '';
  let subscriptionId = '';
  let memberMembershipId = '';

  beforeAll(async () => {
    const plans = [
      { code: 'FREE', name: 'Free', monthlyPrice: 0, seatLimit: 3, projectLimit: 2, apiRequestLimit: 1000, entitlements: { advancedAnalytics: false } },
      { code: 'STARTER', name: 'Starter', monthlyPrice: 49900, seatLimit: 10, projectLimit: 20, apiRequestLimit: 10000, entitlements: { advancedAnalytics: false } },
      { code: 'PROFESSIONAL', name: 'Professional', monthlyPrice: 99900, seatLimit: 50, projectLimit: -1, apiRequestLimit: 100000, entitlements: { advancedAnalytics: true } },
    ];
    for (const plan of plans) await prisma.plan.upsert({ where: { code: plan.code }, update: plan, create: plan });
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, membership: { select: { organizationId: true } } } });
    const organizationIds = users.map((user) => user.membership?.organizationId).filter((id): id is string => Boolean(id));
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    await prisma.$disconnect();
  });

  it('exposes health, service metadata and a JSON 404', async () => {
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', service: 'flowsuite-api' });

    const root = await request(app).get('/').set('Accept', 'application/json');
    expect(root.status).toBe(200);
    expect(root.body.service).toBe('flowsuite-api');

    const redirect = await request(app).get('/').set('Accept', 'text/html');
    expect(redirect.status).toBe(302);

    const missing = await request(app).get('/api/does-not-exist');
    expect(missing.status).toBe(401);

    const rejection = await request(app).get('/api/workspace/dashboard').set(auth('not-a-token'));
    expect(rejection.status).toBe(401);
    expect(rejection.body.error.code).toBe('INVALID_TOKEN');
  });

  it('registers an organization owner and rejects invalid or duplicate registrations', async () => {
    const email = mail('owner');
    const res = await request(app).post('/api/auth/register').send({ name: 'Owner One', email, password: PASSWORD, organizationName: 'Alpha Works' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('OWNER');
    expect(res.headers['set-cookie'][0]).toContain('flowsuite_refresh');
    owner = { token: res.body.accessToken, user: res.body.user };

    const duplicate = await request(app).post('/api/auth/register').send({ name: 'Owner One', email, password: PASSWORD });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMAIL_IN_USE');

    const weak = await request(app).post('/api/auth/register').send({ name: 'X', email: mail('weak'), password: 'short' });
    expect(weak.status).toBe(400);
  });

  it('signs in, rejects bad credentials and returns the current user', async () => {
    const ok = await request(app).post('/api/auth/login').send({ email: owner.user.email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.user.organizationId).toBe(owner.user.organizationId);

    const bad = await request(app).post('/api/auth/login').send({ email: owner.user.email, password: 'WrongPassword1' });
    expect(bad.status).toBe(401);

    const malformed = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(malformed.status).toBe(400);

    const me = await request(app).get('/api/auth/me').set(auth(owner.token));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(owner.user.email);
  });

  it('refreshes and revokes a session through cookies', async () => {
    const agent = request.agent(app);
    const email = mail('refresh');
    const created = await agent.post('/api/auth/register').send({ name: 'Refresh User', email, password: PASSWORD, organizationName: 'Refresh Co' });
    expect(created.status).toBe(201);

    const refreshed = await agent.post('/api/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();

    const anonymous = await request(app).post('/api/auth/refresh');
    expect(anonymous.status).toBe(401);

    const logout = await agent.post('/api/auth/logout');
    expect(logout.status).toBe(200);
    const revoked = await agent.post('/api/auth/refresh');
    expect(revoked.status).toBe(401);
  });

  it('resets a password with a single-use token', async () => {
    const email = mail('reset');
    await request(app).post('/api/auth/register').send({ name: 'Reset User', email, password: PASSWORD });
    const requested = await request(app).post('/api/auth/password/reset-request').send({ email });
    expect(requested.status).toBe(200);
    const token = requested.body.developmentResetToken;
    expect(token).toBeTruthy();

    const changed = await request(app).post('/api/auth/password/reset').send({ token, password: 'NewPassword123' });
    expect(changed.status).toBe(200);
    const reused = await request(app).post('/api/auth/password/reset').send({ token, password: 'NewPassword123' });
    expect(reused.status).toBe(400);

    const login = await request(app).post('/api/auth/login').send({ email, password: 'NewPassword123' });
    expect(login.status).toBe(200);
  });

  it('lists plans and reports the Free subscription with its limits', async () => {
    owner = owner ?? (await registerUser('Owner One', mail('owner2'), 'Alpha Works'));
    const plans = await request(app).get('/api/workspace/plans').set(auth(owner.token));
    expect(plans.status).toBe(200);
    expect(plans.body.data.map((plan: { code: string }) => plan.code)).toContain('PROFESSIONAL');

    const dashboard = await request(app).get('/api/workspace/dashboard').set(auth(owner.token));
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.plan.code).toBe('FREE');
    expect(dashboard.body.plan.limits).toEqual({ seats: 3, projects: 2, apiRequests: 1000 });
    expect(dashboard.body.billing).toEqual({ configured: false });

    const usage = await request(app).get('/api/workspace/usage').set(auth(owner.token));
    expect(usage.status).toBe(200);
    expect(usage.body.used.seats).toBe(1);
  });

  it('enforces the Free project limit and allows work once a project is archived', async () => {
    const first = await request(app).post('/api/workspace/projects').set(auth(owner.token)).send({ name: 'Website Refresh', description: 'Marketing site' });
    expect(first.status).toBe(201);
    projectOneId = first.body.data.id;

    const second = await request(app).post('/api/workspace/projects').set(auth(owner.token)).send({ name: 'Mobile App' });
    expect(second.status).toBe(201);
    projectTwoId = second.body.data.id;

    const blocked = await request(app).post('/api/workspace/projects').set(auth(owner.token)).send({ name: 'Third Project' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PROJECTS_LIMIT_REACHED');

    const archived = await request(app).patch(`/api/workspace/projects/${projectTwoId}`).set(auth(owner.token)).send({ status: 'ARCHIVED' });
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe('ARCHIVED');

    const replacement = await request(app).post('/api/workspace/projects').set(auth(owner.token)).send({ name: 'Brand Program' });
    expect(replacement.status).toBe(201);
    projectTwoId = replacement.body.data.id;
  });

  it('creates, updates and searches customer records', async () => {
    const created = await request(app).post('/api/workspace/customers').set(auth(owner.token)).send({ name: 'Taylor Morgan', company: 'Northstar', email: 'taylor@northstar.test' });
    expect(created.status).toBe(201);
    customerId = created.body.data.id;

    const updated = await request(app).patch(`/api/workspace/customers/${customerId}`).set(auth(owner.token)).send({ phone: '+1 555 0100' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.phone).toBe('+1 555 0100');

    const list = await request(app).get('/api/workspace/customers?search=northstar').set(auth(owner.token));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);

    const invalid = await request(app).post('/api/workspace/customers').set(auth(owner.token)).send({ name: 'X', email: 'nope' });
    expect(invalid.status).toBe(400);
  });

  it('creates tasks with validated assignees and updates their status', async () => {
    const unassigned = await request(app).post(`/api/workspace/projects/${projectOneId}/tasks`).set(auth(owner.token)).send({ title: 'Draft brief', priority: 'high' });
    expect(unassigned.status).toBe(201);
    unassignedTaskId = unassigned.body.data.id;

    const stranger = await request(app).post(`/api/workspace/projects/${projectOneId}/tasks`).set(auth(owner.token)).send({ title: 'Ghost task', assigneeId: 'user-that-does-not-exist' });
    expect(stranger.status).toBe(400);
    expect(stranger.body.error.code).toBe('INVALID_ASSIGNEE');

    const done = await request(app).patch(`/api/workspace/tasks/${unassignedTaskId}/status`).set(auth(owner.token)).send({ status: 'IN_PROGRESS' });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('IN_PROGRESS');

    const list = await request(app).get(`/api/workspace/tasks?projectId=${projectOneId}`).set(auth(owner.token));
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
  });

  it('invites teammates, accepts invitations and enforces the seat limit', async () => {
    const invited = await request(app).post('/api/workspace/members/invitations').set(auth(owner.token)).send({ email: mail('member'), role: 'MEMBER' });
    expect(invited.status).toBe(201);
    inviteToken = invited.body.developmentInviteToken;
    expect(inviteToken).toBeTruthy();

    const accepted = await request(app).post('/api/workspace/members/invitations/accept').send({ name: 'Mira Member', password: PASSWORD, token: inviteToken });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user.role).toBe('MEMBER');
    member = { token: accepted.body.accessToken, user: accepted.body.user };

    const reused = await request(app).post('/api/workspace/members/invitations/accept').send({ name: 'Mira Member', password: PASSWORD, token: inviteToken });
    expect(reused.status).toBe(400);

    const managerInvite = await request(app).post('/api/workspace/members/invitations').set(auth(owner.token)).send({ email: mail('manager'), role: 'MANAGER' });
    expect(managerInvite.status).toBe(201);
    managerInviteToken = managerInvite.body.developmentInviteToken;
    const managerAccepted = await request(app).post('/api/workspace/members/invitations/accept').send({ name: 'Mo Manager', password: PASSWORD, token: managerInviteToken });
    expect(managerAccepted.status).toBe(201);
    manager = { token: managerAccepted.body.accessToken, user: managerAccepted.body.user };

    const overLimit = await request(app).post('/api/workspace/members/invitations').set(auth(owner.token)).send({ email: mail('overflow') });
    expect(overLimit.status).toBe(403);
    expect(overLimit.body.error.code).toBe('SEATS_LIMIT_REACHED');

    const roster = await request(app).get('/api/workspace/members').set(auth(owner.token));
    expect(roster.status).toBe(200);
    memberMembershipId = roster.body.data.find((row: { user: { email: string } }) => row.user.email === member.user.email).id;
    expect(roster.body.invitations).toHaveLength(0);
  });

  it('scopes Member visibility to their own assigned work', async () => {
    const assigned = await request(app).post(`/api/workspace/projects/${projectOneId}/tasks`).set(auth(owner.token)).send({ title: 'Member task', assigneeId: member.user.userId });
    expect(assigned.status).toBe(201);
    assignedTaskId = assigned.body.data.id;

    const memberTasks = await request(app).get('/api/workspace/tasks').set(auth(member.token));
    expect(memberTasks.status).toBe(200);
    expect(memberTasks.body.data.map((task: { title: string }) => task.title)).toEqual(['Member task']);

    const memberProjects = await request(app).get('/api/workspace/projects').set(auth(member.token));
    expect(memberProjects.status).toBe(200);
    expect(memberProjects.body.data.map((project: { id: string }) => project.id)).toEqual([projectOneId]);

    const ownUpdate = await request(app).patch(`/api/workspace/tasks/${assignedTaskId}/status`).set(auth(member.token)).send({ status: 'DONE' });
    expect(ownUpdate.status).toBe(200);

    const otherUpdate = await request(app).patch(`/api/workspace/tasks/${unassignedTaskId}/status`).set(auth(member.token)).send({ status: 'DONE' });
    expect(otherUpdate.status).toBe(403);
  });

  it('denies Member escalation while letting Managers create work', async () => {
    const create = await request(app).post('/api/workspace/projects').set(auth(member.token)).send({ name: 'Sneaky Project' });
    expect(create.status).toBe(403);

    const roster = await request(app).get('/api/workspace/members').set(auth(member.token));
    expect(roster.status).toBe(403);

    const audit = await request(app).get('/api/workspace/audit').set(auth(member.token));
    expect(audit.status).toBe(403);

    const usage = await request(app).get('/api/workspace/usage').set(auth(member.token));
    expect(usage.status).toBe(403);

    const analytics = await request(app).get('/api/workspace/analytics').set(auth(owner.token));
    expect(analytics.status).toBe(403);
    expect(analytics.body.error.code).toBe('ENTITLEMENT_REQUIRED');

    await request(app).patch(`/api/workspace/projects/${projectTwoId}`).set(auth(owner.token)).send({ status: 'ARCHIVED' });
    const managerProject = await request(app).post('/api/workspace/projects').set(auth(manager.token)).send({ name: 'Manager Project' });
    expect(managerProject.status).toBe(201);

    const managerInvite = await request(app).post('/api/workspace/members/invitations').set(auth(manager.token)).send({ email: mail('blocked') });
    expect(managerInvite.status).toBe(403);
  });

  it('records audit history for organization actions', async () => {
    const audit = await request(app).get('/api/workspace/audit').set(auth(owner.token));
    expect(audit.status).toBe(200);
    const actions = audit.body.data.map((row: { action: string }) => row.action);
    expect(actions).toContain('organization.created');
    expect(actions).toContain('project.created');
    expect(actions).toContain('member.invited');
    expect(actions).toContain('member.joined');

    const filtered = await request(app).get('/api/workspace/audit?action=invited').set(auth(owner.token));
    expect(filtered.body.data.every((row: { action: string }) => row.action.includes('invited'))).toBe(true);
  });

  it('changes roles with audit and invalidates the previous role token', async () => {
    const promoted = await request(app).patch(`/api/workspace/members/${memberMembershipId}/role`).set(auth(owner.token)).send({ role: 'ADMIN' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data.role).toBe('ADMIN');

    const stale = await request(app).get('/api/workspace/members').set(auth(member.token));
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('MEMBERSHIP_REVOKED');

    const forbidden = await request(app).patch(`/api/workspace/members/${memberMembershipId}/role`).set(auth(manager.token)).send({ role: 'ADMIN' });
    expect(forbidden.status).toBe(403);

    const removed = await request(app).delete(`/api/workspace/members/${memberMembershipId}`).set(auth(owner.token));
    expect(removed.status).toBe(204);
  });

  it('isolates projects, tasks and customers between organizations', async () => {
    other = await registerUser('Other Owner', mail('other'), 'Beta Works');

    const otherProject = await request(app).post('/api/workspace/projects').set(auth(other.token)).send({ name: 'Beta Project' });
    expect(otherProject.status).toBe(201);

    const otherList = await request(app).get('/api/workspace/projects').set(auth(other.token));
    expect(otherList.body.data.map((project: { id: string }) => project.id)).not.toContain(projectOneId);
    expect(otherList.body.data).toHaveLength(1);

    const crossProject = await request(app).patch(`/api/workspace/projects/${projectOneId}`).set(auth(other.token)).send({ name: 'Hijacked' });
    expect(crossProject.status).toBe(404);

    const crossTaskCreate = await request(app).post(`/api/workspace/projects/${projectOneId}/tasks`).set(auth(other.token)).send({ title: 'Cross task' });
    expect(crossTaskCreate.status).toBe(404);

    const crossTaskUpdate = await request(app).patch(`/api/workspace/tasks/${assignedTaskId}/status`).set(auth(other.token)).send({ status: 'DONE' });
    expect(crossTaskUpdate.status).toBe(404);

    const crossCustomer = await request(app).patch(`/api/workspace/customers/${customerId}`).set(auth(other.token)).send({ name: 'Hijacked Customer' });
    expect(crossCustomer.status).toBe(404);

    const otherTasks = await request(app).get('/api/workspace/tasks').set(auth(other.token));
    expect(otherTasks.body.data).toHaveLength(0);

    const otherCustomers = await request(app).get('/api/workspace/customers').set(auth(other.token));
    expect(otherCustomers.body.data).toHaveLength(0);

    const crossRole = await request(app).patch(`/api/workspace/members/${memberMembershipId}/role`).set(auth(other.token)).send({ role: 'ADMIN' });
    expect(crossRole.status).toBe(404);
  });

  it('reports unconfigured billing instead of failing silently', async () => {
    const checkout = await request(app).post('/api/workspace/billing/checkout').set(auth(owner.token)).send({ planCode: 'PROFESSIONAL' });
    expect(checkout.status).toBe(503);
    expect(checkout.body.error.code).toBe('BILLING_NOT_CONFIGURED');

    const cancel = await request(app).post('/api/workspace/billing/cancel').set(auth(owner.token));
    expect(cancel.status).toBe(400);

    const history = await request(app).get('/api/workspace/billing/history').set(auth(owner.token));
    expect(history.status).toBe(200);
    expect(history.body.data).toEqual([]);

    const webhook = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').send('{}');
    expect(webhook.status).toBe(503);
  });

  it('applies subscription lifecycle changes from signed Stripe webhooks', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_integration';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_integration';
    const stripe = new Stripe('sk_test_integration');
    const customerId = `cus_integration_${stamp}`;
    const subscriptionStripeId = `sub_integration_${stamp}`;
    const send = (event: unknown) => {
      const payload = JSON.stringify(event);
      return request(app)
        .post('/api/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_integration' }))
        .send(payload);
    };

    const rejected = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('stripe-signature', 'bad').send('{}');
    expect(rejected.status).toBe(400);

    const upgraded = await send({
      id: 'evt_upgrade', object: 'event', type: 'checkout.session.completed',
      data: { object: { id: 'cs_test', object: 'checkout.session', customer: customerId, subscription: subscriptionStripeId, metadata: { organizationId: owner.user.organizationId, planCode: 'PROFESSIONAL' } } },
    });
    expect(upgraded.status).toBe(200);

    const professional = await prisma.plan.findUniqueOrThrow({ where: { code: 'PROFESSIONAL' } });
    const afterUpgrade = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: owner.user.organizationId } });
    expect(afterUpgrade.planId).toBe(professional.id);
    expect(afterUpgrade.status).toBe('ACTIVE');
    subscriptionId = afterUpgrade.id;

    const dashboard = await request(app).get('/api/workspace/dashboard').set(auth(owner.token));
    expect(dashboard.body.plan.code).toBe('PROFESSIONAL');
    expect(dashboard.body.plan.limits.projects).toBe(-1);

    const analytics = await request(app).get('/api/workspace/analytics').set(auth(owner.token));
    expect(analytics.status).toBe(200);
    expect(analytics.body.tasksByStatus.length).toBeGreaterThan(0);

    const pastDue = await send({ id: 'evt_failed', object: 'event', type: 'invoice.payment_failed', data: { object: { id: 'in_1', object: 'invoice', customer: customerId } } });
    expect(pastDue.status).toBe(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).status).toBe('PAST_DUE');

    const recovered = await send({ id: 'evt_paid', object: 'event', type: 'invoice.payment_succeeded', data: { object: { id: 'in_2', object: 'invoice', customer: customerId } } });
    expect(recovered.status).toBe(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).status).toBe('ACTIVE');

    const cancelled = await send({ id: 'evt_deleted', object: 'event', type: 'customer.subscription.deleted', data: { object: { id: subscriptionStripeId, object: 'subscription', metadata: { organizationId: owner.user.organizationId, planCode: 'PROFESSIONAL' }, status: 'canceled', cancel_at: null } } });
    expect(cancelled.status).toBe(200);
    const expired = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    const free = await prisma.plan.findUniqueOrThrow({ where: { code: 'FREE' } });
    expect(expired.status).toBe('EXPIRED');
    expect(expired.planId).toBe(free.id);

    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });
});
