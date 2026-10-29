# FlowSuite architecture and security

FlowSuite is a TypeScript workspace monorepo: a React/Vite single-page application, an Express REST API, a PostgreSQL database accessed through Prisma, and a Redis service reserved for rate limiting and caching. The backend and frontend use open-source tools. Stripe checkout and invoice APIs are used in test mode only when Stripe sandbox credentials and price IDs are configured.

## Tenant isolation

New account creation creates the user, a unique organization, an OWNER membership and the organization's Free subscription in a single Prisma transaction. A user has at most one Membership, while organizations can have many memberships. Every tenant-owned resource carries `organizationId`. The API constructs tenant scope only from the signed access token's organization claims; clients cannot choose an organization to read or mutate. Middleware also checks the corresponding live membership and current role before any protected API route proceeds. Every project, task, customer, usage counter, invitation and audit query in the API is scoped using this server-resolved organization ID.

Tasks carry a tenant key as well as a project key, and are queried with both. Nested customer links, project IDs and task assignees are checked against the authenticated organization before a write. Out-of-tenant resource IDs receive not-found responses rather than revealing that another tenant's record exists. Members are filtered to projects containing an assigned task and to tasks assigned to their own user ID. Managers and workspace administrators see all projects and tasks in their own tenant.

## Authentication and sessions

Passwords are hashed with bcrypt (12 rounds). Access tokens are JWTs signed with a required production `JWT_SECRET`, issued for 15 minutes, and contain the user's organization membership and role. A 30-day randomly generated refresh token is stored only as a SHA-256 digest in PostgreSQL, delivered in an HttpOnly, SameSite=Strict cookie, and rotated transactionally when used. Logout, password changes, role/membership revocation and expiration invalidate or restrict sessions. Password reset tokens are one-use, stored as digests and expire after 30 minutes; the HTTP response reveals a token only in development because notification delivery is out of scope. Production must issue reset links through its trusted email-delivery system before enabling public account recovery. Login has a bounded per-process failure window and the authentication endpoints have IP-level rate limiting.

## Authorization

The server is authoritative. Owner-only billing, role changes, member removal and audit-exempt organization management cannot be enabled by changing the client. Admins can manage invitations, projects, tasks, customers, analytics and audit visibility, but not billing or roles. Managers can manage projects, tasks and customers, but not organization membership, subscription billing or analytics. Members can view assigned work and update only their own task statuses. `src/services/authorization.ts` centralizes policy predicates; Express role middleware and resource-specific checks enforce those policies.

Every API request is checked for a signed identity and for current live organization membership. Resource access checks combine role with tenant scope. API write schemas validate and constrain each submitted value. Responses avoid leaking raw database exceptions. Refresh/session cookies use secure attributes in production; CORS is restricted to the configured application origin.

## Plans, limits and entitlements

Plan names, limits and features are database configuration, seeded idempotently in `apps/api/prisma/seed.ts`, never compared to plan names as a feature grant. Free allows 3 seats, 2 active projects and 1,000 monthly API requests; Starter allows 10, 20 and 10,000; Professional allows 50, unlimited projects and 100,000, plus `advancedAnalytics`, `auditExport` and `customRoles` entitlements. An unlimited numeric cap is represented as `-1`. Seat/project limits are checked against fresh database counts in the same organization before writes; API usage is tracked against the current UTC year-month bucket and checked against the database-configured limit. Entitlement middleware checks named flags such as `advancedAnalytics` and returns a clear upgrade-required message.

The API request counter uses atomic PostgreSQL upserts. Redis is included in Compose as the extension point for a future distributed rate-limit/cache implementation; the core business caps are authoritative in Postgres. All tenant resources and counters must remain transactionally scoped even if a cache is added.

## Subscription lifecycle

Checkout creates Stripe test-mode subscription Checkout sessions from price IDs stored in environment variables. The raw request body of the webhook route is signature-verified before processing. A valid checkout completion updates the subscription tier; payment-failed/succeeded events set PAST_DUE/ACTIVE and Stripe subscription events synchronize cancellation and expiration. Subscription-plan changes and cancellation are recorded in the tenant audit log. On EXPIRED, the webhook assigns the database Free plan. No live Stripe secrets or card data are included in the application. Use Stripe CLI's test webhook forwarding during local acceptance; verify the webhook's metadata includes the organization and plan identifiers.

## Auditability and operations

Membership invites, role changes, removals, organization creation, project creation/archive and billing changes create timestamped audit records with actor and tenant context. An Owner or Admin can retrieve these through a tenant-scoped, paginated and action-filterable API. The app has a health endpoint, consistent JSON error envelope, safe HTTP headers, database health/build checks, OpenAPI documentation and a GitHub Actions CI workflow.

## Four-week delivery mapping

- Week 1 foundations: schema, registration/login/refresh/logout, password reset, organization creation, initial Free plan, membership model and health endpoint.
- Week 2 product slice: workspace dashboard, tenant-scoped projects/tasks/customers, invite acceptance and server-enforced role permissions.
- Week 3 plans: database-configured plans and entitlements, enforced seat/project/API limits, Stripe test Checkout/webhook, usage dashboard and audit UI.
- Week 4 hardening: automated authorization/tenant-isolation tests, Compose stack, CI, OpenAPI and this architecture note. Add a real deployment target and complete sign-in, reset-email and Stripe webhook verification only after environment credentials and hosting are configured.

## Known deployment prerequisites

Configure a strong random `JWT_SECRET`, externally reachable `APP_URL`, PostgreSQL URL, HTTPS/reverse proxy and Stripe test secret, webhook secret and price IDs in the deployment environment. A production password-reset email service has not been integrated because email delivery is explicitly out of scope. Use `npm run db:migrate --workspace @flowsuite/api` for a checked-in migration before deploying schema changes; do not use Prisma's development `db push` in production. No production credentials are checked into the repository.
