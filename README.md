# PFA Cage Rentals

Internal billing tool for [PFA Baseball](https://pfasports.com). Replaces a
shared Excel sheet that tracked cage / bullpen / weight-room rentals with a
real web app at [pfacagerentals.com](https://pfacagerentals.com). Coaches log
their sessions; admins review the schedule, manage per-coach rates, and
export monthly billing to Excel.

## Stack

- **Framework:** Next.js 16 (App Router) + React 19
- **Database:** Neon Postgres + Drizzle ORM
- **Auth:** Auth.js v5 (Google OAuth + Resend magic-link)
- **Hosting:** Vercel
- **Styling:** Tailwind 4 + shadcn/ui primitives
- **Reports:** ExcelJS
- **DnD:** @dnd-kit/core
- **Error tracking:** Sentry
- **Rate limiting:** Upstash Redis
- **Tests:** Vitest (unit + integration) + Playwright (e2e)

## Local dev setup

You'll need:
- Node 22+ and npm
- A Neon Postgres branch (free tier is fine)
- An Auth.js session secret, Google OAuth credentials, and a Resend API key

```bash
# clone + install
git clone https://github.com/Jacobmagna/pfa-cage-rentals.git
cd pfa-cage-rentals
npm install

# fill in .env.local with real values (see .env.example for every key)
cp .env.example .env.local

# create tables + seed default rates and resources
npm run db:migrate
npm run db:seed

# start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in. The first
sign-in by `jacob@themagnas.com`, `mdm@pfasports.com`, or
`esther@pfasports.com` is auto-promoted to `admin`; everyone else lands as a
coach.

## Common scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server with HMR (port 3000) |
| `npm run build` | Production build |
| `npm start` | Run the production build locally |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest) — 100% coverage required on `billing.ts` |
| `npm run test:integration` | Integration tests — requires `INTEGRATION_DATABASE_URL` pointed at a non-prod Neon branch |
| `npm run test:e2e` | Playwright e2e suite |
| `npm run db:generate` | Generate a new Drizzle migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Idempotent seed for resources + default rates |

## Deploying

Push to `main` — Vercel auto-deploys. Direct-to-main is the team convention;
the pre-commit hook runs lint-staged ESLint + `tsc --noEmit`, and CI runs
lint + typecheck + build + `npm run test:coverage` on every push.

If a migration is part of the change, apply it to production from your local
machine **before** pushing the code that depends on it:

```bash
DATABASE_URL="<production neon url>" npm run db:migrate
git push
```

## More docs

- [BRAINSTORM.md](./BRAINSTORM.md) — product / scope source of truth
- [docs/reference/design-spec.md](./docs/reference/design-spec.md) — visual design system (dark + warm gold, Vercel/Linear vibe)
- [docs/reference/architecture.md](./docs/reference/architecture.md) — 1-page request-flow + auth/billing/email/audit deep dive
- [docs/process/production-checklist.md](./docs/process/production-checklist.md) — canonical work tracker (stages A–L)
- [docs/operations/runbook.md](./docs/operations/runbook.md) — site-down diagnostic order, PITR restore, secret rotation
