# FlowSuite

A multi-tenant organization workspace for team, customer, project and task management. This solo-built four-week scope delivers tenant isolation, server-enforced role permissions, configurable plan limits and entitlements, audit history and a Stripe test-mode billing path.

## Stack

- React 18, TypeScript, Vite, Recharts and lucide-react
- Express 4, Node.js 20+, TypeScript, Zod, bcryptjs and JWT
- PostgreSQL 16 and Prisma ORM
- Redis 7 service in the Docker Compose development environment
- Vitest tests and GitHub Actions CI
- Stripe-hosted test Checkout and signed webhook sync (configure sandbox credentials; no real payment processing)

## Run the full local stack

Docker and the Docker Compose plugin are required. At the repository root:

```bash
docker compose up --build
```

The web app is at <http://localhost:5173>, the API at <http://localhost:4000/api> and its health check at <http://localhost:4000/api/health>. PostgreSQL is available on port 5432 and Redis on port 6379. Compose creates and seeds plan rows on API startup and stores Postgres/Redis data in named local volumes.

For development without Docker, run a local PostgreSQL 16 database, copy `apps/api/.env.example` to `apps/api/.env` and set its `DATABASE_URL` and a random `JWT_SECRET`. (Redis is optional for the included core limit enforcement.) Then:

```bash
npm ci
npm run db:generate
npm run db:migrate --workspace @flowsuite/api
npm run db:seed
npm run dev
```

Vite proxies `/api` to `http://localhost:4000` by default. Set `VITE_API_PROXY` in `apps/web/.env` to change that target. The first account creates its own workspace and becomes its Owner. New accounts and newly created plan subscriptions start on Free.

## Test and build

```bash
npm run db:generate
npm test
npm run build
```

`npm test` runs the backend test suite with V8 coverage and enforces a 70% statement-coverage threshold. It mixes fast unit tests for the role matrix with HTTP integration tests that drive the real Express app against PostgreSQL: registration and sessions, tenant isolation between two organizations, Member/Manager/Admin permissions, seat and project limits, entitlements, audit history, and the signed Stripe webhook lifecycle. Integration tests apply their own schema assumptions, create uniquely named organizations and delete them afterwards, so the database must be reachable and migrated (`DATABASE_URL`). They are skipped automatically when no database is available.

The GitHub Actions workflow runs the tests and both application builds on each push and pull request. CI configures PostgreSQL, applies the Prisma migration, seeds the plans and uses only fake CI signing keys.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection used by Prisma |
| `JWT_SECRET` | Yes in production | Random secret for signing 15-minute access tokens; never commit its real value |
| `APP_URL` | Yes in production | Exact HTTPS origin for CORS, cookies and Checkout redirects |
| `PORT` | No | API port, defaults to `4000` |
| `STRIPE_SECRET_KEY` | Billing only | Stripe **test** secret key (`sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | Billing only | Secret from Stripe CLI or test-mode webhook (`whsec_…`) |
| `STRIPE_PRICE_STARTER` | Billing only | Stripe test-mode recurring Starter price ID |
| `STRIPE_PRICE_PROFESSIONAL` | Billing only | Stripe test-mode recurring Professional price ID |
| `VITE_API_PROXY` | No | Development-only Vite API proxy URL |
| `TRUST_PROXY` | No | Set `true` only behind a trusted single-hop reverse proxy |

Templates are in `apps/api/.env.example` and `apps/web/.env.example`. Real secrets belong in the deployment platform's secret manager, not source control.

### Stripe sandbox configuration

Create two recurring prices in the Stripe **test** dashboard and set the two `STRIPE_PRICE_*` variables. Start `stripe listen --forward-to localhost:4000/api/billing/webhook`, then set its test webhook signing secret in `STRIPE_WEBHOOK_SECRET` and restart the API. Test registration and usage without Stripe; checkout shows a clear configuration error until test credentials and the price IDs are set. Only the Owner role may start or cancel a subscription. No real cards or live payment credentials are supported.

## Roles and data isolation

Every user belongs to one workspace for this project. Roles are Owner, Admin, Manager and Member. The API resolves the tenant from the signed session, checks live membership and enforces role/resource permissions on every protected route. Members see assigned projects/tasks and may update their own task status; Owner/Admin/Manager project reads remain tenant-scoped. Only the Owner can manage billing, roles and removals; Admins can invite members and view audit/analytics. Seat, project and API request limits are checked using plan records, and features are gated through named plan entitlements rather than plan-name comparisons.

The API does not accept a client-supplied organization ID as authorization. Invite acceptance is token-protected, user creation is constrained to that invitation's organization and user email uniqueness prevents multiple memberships/accounts across tenants.

## API documentation

The OpenAPI 3.0 contract is in [`openapi.yaml`](openapi.yaml). Principal endpoints under `/api`:

- `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`
- `POST /auth/password/reset-request`, `/auth/password/reset`; `GET /auth/me`
- `GET /workspace/dashboard`, `/plans`, `/members`, `/projects`, `/tasks`, `/customers`, `/usage`, `/audit`, `/analytics`
- `POST /workspace/members/invitations`; unauthenticated token-protected `POST /workspace/members/invitations/accept`
- role-checked project, task, customer and membership mutations under `/workspace`
- Owner-only `POST /workspace/billing/checkout`, `/billing/cancel`; `GET /billing/history`
- signature-verified raw-body `POST /billing/webhook`

Protected requests use `Authorization: Bearer <15-minute access token>`. The server returns a longer-lived opaque refresh token in an HttpOnly, SameSite=Strict cookie and rotates it on refresh. Pagination uses `?page=1&pageSize=20` (maximum size 100). Errors are JSON `{ error: { code, message } }` responses.

## Deployment

The service is a standard Node.js/PostgreSQL application. Deploy the API, static Vite `apps/web/dist` assets and managed PostgreSQL to a Node-compatible host (for example Render, Railway or a VM). Set the environment variables above in the secret manager, set `APP_URL` to the actual HTTPS frontend origin, configure Stripe's **test-mode** webhook for `/api/billing/webhook`, and use `npm ci`, `npm run db:generate`, `npm run build`, `npm run db:migrate --workspace @flowsuite/api`, and `npm run start --workspace @flowsuite/api`. Build and serve the frontend with `npm run build --workspace @flowsuite/web`; configure the host/CDN to serve its `dist` directory and proxy `/api` to the API. Keep the raw-body webhook route unmodified by intermediary body parsers.

Use checked-in Prisma migrations in production; generate/review them in development with `npm run db:migrate --workspace @flowsuite/api`. The sample one-command Compose setup uses `prisma db push` only for a disposable local development database. Do not deploy without a production-grade reset-email delivery integration and operational HTTPS secrets. Never paste Stripe or signing secrets into source files or commits.

## Architecture

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) for tenant isolation, session/RBAC, limit/entitlement and lifecycle design.
