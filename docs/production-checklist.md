# PFA Cage Rentals — Production Completion Checklist

**Purpose:** the single working document for getting this app from Phase 1.5 (where we are) to live, billing-grade production. Check items off in order — they're sequenced so nothing later requires undoing something earlier.

**How to use:** open this doc at the start of every session. Pick the lowest-numbered unchecked item. Do it. Check it off. Commit the check-off in the same commit as the work.

**Status legend:**
- `[ ]` = not started
- `[~]` = in progress
- `[x]` = done
- `[-]` = deliberately skipped (note why inline)

Cross-refs:
- Categories (1–14) reference `docs/production-diagnostic.md` (or this file's section headers — same numbering as the deep-dive diagnostic).
- Phase numbers (Phase 0–9) reference `BRAINSTORM.md`.
- Design tokens reference `docs/design-spec.md`.

---

# STAGE A — Guard rails (do BEFORE Phase 2) ✓ COMPLETE 2026-05-23

Rationale: install error visibility, CI, and migration safety **before** any new product code lands. Every later phase benefits from these, and adding them after means retrofitting noise into a larger codebase.

**Status:** All P0 items done. A4b deferred (P1 — ship only if real CSP breakage observed; current enforce-mode works for the live surface).

### A1. CI workflow on every PR — `[x]`
- Add `.github/workflows/ci.yml`: matrix on Node 24, steps = `npm ci`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.
- Trigger on PRs to `main` and pushes to any branch.
- Acceptance: opening a PR with a TS error blocks merge with a red check.
- Est: 30 min.

### A2. Branch protection on `main` — `[x]`
- GitHub repo → Settings → Branches → Protection rule for `main`: require status check `ci` (from A1) to pass, require linear history.
- Skip "require approving review" since you're solo — adds friction without value.
- Acceptance: `git push origin main` directly is blocked (forces PR flow).
- Est: 5 min.

### A3. Sentry error tracking — `[x]`
- `npm i @sentry/nextjs` → `npx @sentry/wizard@latest -i nextjs` → walk wizard.
- Create Sentry project under your account, free tier.
- Add `SENTRY_AUTH_TOKEN`, `NEXT_PUBLIC_SENTRY_DSN` to Vercel env vars (Production + Preview).
- Wrap `src/auth.ts` Drizzle adapter failures and `src/db/migrate.ts` errors in `Sentry.captureException`.
- Acceptance: throw a test error from a server action → email arrives within 1 min, error visible in Sentry dashboard.
- Est: 45 min.

### A4. Security headers in `next.config.ts` — `[x]`
- Add `headers()` returning: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://vercel.live; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.resend.com https://*.sentry.io; frame-ancestors 'none'`.
- Test with https://securityheaders.com — target A+ grade.
- Acceptance: securityheaders.com scan of `www.pfacagerentals.com` returns A or A+.
- Est: 45 min (iterating CSP).
- **Done in A3 PR** (bundled because both touch next.config.ts). All 6 headers live and verified via curl.

### A4b. CSP violation reporting (lifted from doc-insured pattern) — `[ ]`
- Add `/api/csp-report` POST route that ingests CSP violation reports, logs to Sentry as `csp.violation` events.
- Add `report-uri /api/csp-report` directive to existing CSP.
- **When to do this:** only after seeing suspected breakage. The current CSP enforce-mode works for the live surface (sign-in, Google OAuth, Resend, Sentry beacons) — adding the endpoint preemptively is fine but not urgent. Bumps a flag when Stage J introduces new integrations (PWA manifest, etc.) that might trip CSP.
- Acceptance: a synthetic violation (e.g. inline-style probe page) lands as a Sentry event tagged `csp.violation`.
- Est: 45 min.
- Priority: P1 (Stage J pre-launch, or earlier if a real violation is observed).

### A5. DB migrations run automatically on deploy — `[x]`
- Add `vercel-build` script in `package.json`: `"vercel-build": "npm run db:migrate && next build"`.
- Swap custom migrator to Drizzle's official `migrate()` from `drizzle-orm/neon-http/migrator` — tracks applied migrations in `__drizzle_migrations` table, idempotent across deploys (the previous custom migrator re-ran every statement, would have failed on second Vercel deploy with `type "X" already exists`).
- Verify Vercel build log shows migration applied (or "up to date") before Next.js build.
- Worst case rollback: Vercel build fails → no new deploy → old version still serves users. Migration that succeeded leaves DB ahead of code; acceptable risk for additive migrations (the two-step migration discipline from CI section keeps destructive changes safe).
- Acceptance: push a no-op migration change → Vercel build log shows migrator output before Next.js compile.
- Est: 30 min (took ~1h due to idempotency fix for the pre-existing migration).

### A6. Vercel + Neon spend alerts — `[x]`
- Vercel → Settings → Billing → set notification at 75% of free tier usage (bandwidth, function-hours).
- Neon → Settings → Usage Alerts → set at 75% of free tier (storage, compute hours).
- Acceptance: alerts appear in email inbox as test entries.
- Est: 10 min.

### A7. Uptime monitoring — `[x]`
- Sign up Better Stack (https://betterstack.com) free tier.
- Add monitor: GET `https://www.pfacagerentals.com/api/health`, 3-min interval, expect 200 + JSON `{ status: "ok" }`. (`/api/health` lands in A8; if A8 is deferred, fall back to `/api/auth/csrf`.)
- Alert destination: email + push (install Better Stack mobile app).
- Acceptance: pause Vercel deploy briefly, get alert within 6 min.
- Est: 15 min.

### A8. validateRequiredEnv + /api/health endpoint (lifted from doc-insured) — `[x]`
- Create `src/lib/env.ts` exporting:
  - `REQUIRED_SCHEMA` (Zod) listing every env var that must be set for production to function (DATABASE_URL, AUTH_SECRET, AUTH_URL, AUTH_GOOGLE_ID/SECRET, AUTH_RESEND_KEY, NEXT_PUBLIC_SENTRY_DSN — extend per slice).
  - `getMissingRequiredEnv()` returning the list of vars that are missing or malformed.
  - `validateRequiredEnv()` that logs loudly but **never throws** (an instrumentation-time throw bricks every route including /api/health — see doc-insured incident comment).
- Call `validateRequiredEnv()` from `instrumentation.ts`'s `register()`.
- Add `src/app/api/health/route.ts`: GET returns 200 `{ status: "ok", commit: VERCEL_GIT_COMMIT_SHA }` when env is valid, else 503 `{ status: "degraded", missing: [...] }`.
- A7's uptime monitor switches to /api/health (richer signal than /api/auth/csrf).
- Acceptance: temporarily unset a required env var in Vercel preview → /api/health returns 503 with the missing var named; Better Stack alerts.
- Est: 1.5 h.
- Priority: P0 — gives uptime monitor a real signal vs blind.

### A9. Explicit serverActions allowedOrigins — `[x]`
- In `next.config.ts`:
  ```ts
  experimental: {
    serverActions: {
      allowedOrigins: ["www.pfacagerentals.com", "pfacagerentals.com"],
    },
  },
  ```
- Why: default is request's own host. Setting explicitly documents the security boundary and prevents a future proxy/CDN/preview-domain config from silently widening it.
- Acceptance: Vercel preview deploys still work (they use *.vercel.app — confirm they're whitelisted or use a localhost override during preview tests).
- Est: 20 min.
- Priority: P1.

---

# STAGE B — Data foundation (still BEFORE Phase 2 product work)

Rationale: build the **reusable primitives** that all subsequent server actions will use. Doing this first means Phase 2 writes against solid abstractions instead of inlining validation/auth/audit logic that you'd refactor later.

### B1. Install Zod + validation conventions — `[x]`
- `npm i zod`. (already installed at 4.4.3 from prior work)
- Create `src/lib/schemas/` directory. One file per entity (`session.ts`, `coach.ts`, `rate-override.ts`).
- Pattern: each file exports `createXSchema`, `updateXSchema`, inferred TS types via `z.infer`.
- Acceptance: a placeholder `src/lib/schemas/user.ts` exists and is imported in one server action successfully.
- Est: 30 min.
- **Done:** `src/lib/schemas/user.ts` (createUserSchema, updateUserSchema, userRoleSchema, inferred types) imported by `src/app/coach/actions.ts` (`updateOwnProfile`). Convention established for subsequent entity schemas.

### B2. Pure billing helpers — `[x]`
- Create `src/lib/billing.ts`. Pure functions only. No DB calls, no React.
- Functions to implement:
  - `slotsBetween(startAt: Date, endAt: Date): number` — count 30-min slots, validate start < end, round to slot boundaries.
  - `rateForSlot(resourceType: 'cage' | 'bullpen' | 'weight_room', coachId: string, overrides: RateOverride[]): number` — returns $ per 30-min slot.
  - `chargeForSession(session, overrides): { slots: number; rate: number; total: number }`.
- Will be tested in stage B5 — write the test alongside.
- Acceptance: module exports above functions with TS types matching schema in B1.
- Est: 1.5 h.
- **Done:** [src/lib/billing.ts](../src/lib/billing.ts) exports `slotsBetween`, `rateForSlot`, `chargeForSession`, plus `DEFAULT_RATES_PER_SLOT_CENTS` (for C2 seed) and types `ResourceType`, `RateOverride`, `SessionInput`, `ChargeBreakdown`. Cents-only, pure, throws on zero/negative-duration sessions. Tests land in B6.

### B3. Audit log schema + helper — `[x]`
- Drizzle schema in `src/db/schema.ts` (add to existing file):
  ```ts
  export const auditAction = pgEnum("audit_action", ["create", "update", "delete"]);
  export const auditLog = pgTable("audit_log", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    actorUserId: text("actor_user_id").notNull().references(() => users.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: auditAction("action").notNull(),
    diff: jsonb("diff"),
    ts: timestamp("ts", { mode: "date" }).notNull().defaultNow(),
  });
  ```
- Generate migration, apply via CI.
- Helper `src/lib/audit.ts`: `logAudit(tx, { actorUserId, entityType, entityId, action, before?, after? })` — computes diff via shallow object compare, inserts row inside the same transaction.
- Acceptance: helper called from a test mutation creates an audit row with non-null diff.
- Est: 1 h.
- **Done:** auditLog table + auditAction enum in [src/db/schema.ts](../src/db/schema.ts) with `(entity_type, entity_id)` and `(ts)` indexes for the common lookup patterns. Migration [drizzle/0001_safe_the_twelve.sql](../drizzle/0001_safe_the_twelve.sql) applied + verified idempotent. Helper at [src/lib/audit.ts](../src/lib/audit.ts) accepts `db` or a transaction handle (typed as `NeonHttpDatabase<typeof schema>`); diff shape: `{after}` for create, `{before}` for delete, changed-keys-only `{before, after}` for update (via exported `shallowDiff`). Acceptance test runs in C8.

### B4. Auth ownership guards — `[x]`
- Create `src/lib/authz.ts`:
  - `requireSession()` → throws redirect to `/` if no session.
  - `requireRole(role)` → throws redirect if user.role !== role.
  - `requireSessionOwnership(sessionRow, user)` → throws if `user.role !== 'admin' && sessionRow.coachId !== user.id`.
- Pattern: every server action's first line calls one of these.
- Acceptance: `requireRole("admin")` called from coach session → throws + redirects (test with curl).
- Est: 45 min.
- **Done:** [src/lib/authz.ts](../src/lib/authz.ts) exports all three helpers with `AuthedSession` type. Retrofitted [src/app/admin/page.tsx](../src/app/admin/page.tsx), [src/app/coach/page.tsx](../src/app/coach/page.tsx), and [src/app/coach/actions.ts](../src/app/coach/actions.ts) to use them — proves the helpers work in real route + server-action contexts. Live curl test will follow once Vercel picks up the deploy.

### B5. Magic-link rate limiting — `[x]`
- Sign up Upstash (https://upstash.com) free tier → create Redis DB → copy REST URL + token.
- `npm i @upstash/ratelimit @upstash/redis`.
- Wrap the magic-link server action: 5 requests per email per hour, 10 per IP per hour.
- Add `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` to Vercel env (Production + Preview).
- Acceptance: hammering "Email me a sign-in link" 6 times from same browser returns rate-limit error on 6th.
- Est: 1 h.
- **Done:** Dedicated Upstash account (jacob+pfa@themagnas.com, separate from doc-insured) → DB `pfa-cage-rentals` in us-east-1. [src/lib/ratelimit.ts](../src/lib/ratelimit.ts) lazy-inits Upstash (so CI builds work without secrets) and exposes `checkMagicLinkRateLimit(email, ip)` with sliding-window limits (5/h email, 10/h IP). Magic-link inline action moved to [src/app/actions.ts](../src/app/actions.ts) (`requestMagicLink`), now extracts client IP via `x-forwarded-for` header, runs the check, and redirects to `/?error=email-limit|ip-limit|missing-email` on failure. [src/app/page.tsx](../src/app/page.tsx) renders the error banner from searchParams. `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` added to `REQUIRED_SCHEMA` in [src/lib/env.ts](../src/lib/env.ts) so `/api/health` flags missing config. Smoke-tested locally against real Upstash: 5 allowed, 6th blocked with `email-limit` as expected.

### B6. Unit tests for billing helpers — `[x]`
- `npm i -D vitest @vitest/coverage-v8`.
- Add `vitest.config.ts`, add `"test": "vitest"` script.
- Test `src/lib/billing.ts`: edge cases for slot counting (back-to-back lessons spanning multiple slots, half-slot rounding, start-equals-end, overnight sessions if relevant).
- Test rate selection: default rate, single coach override, multiple overrides (correct precedence).
- Test `chargeForSession`: integration of slot count × rate.
- Target: 100% line coverage on `src/lib/billing.ts`.
- Acceptance: `npm test` runs, all green, coverage report shows 100% on billing.ts.
- Est: 2 h.
- **Done:** [vitest.config.ts](../vitest.config.ts) with v8 coverage + 100% thresholds on all four metrics. [src/lib/billing.test.ts](../src/lib/billing.test.ts) has 21 tests covering slot rounding (exact, off-boundary start/end, both ends, overnight, zero-duration throw, negative throw), rate selection (default for each resource type, coach match, wrong coach, wrong resource type, multiple-match precedence), chargeForSession (default, override, weight_room, rounding propagation), and a regression test on `DEFAULT_RATES_PER_SLOT_CENTS`. Coverage report: 100% statements, branches, functions, lines.

### B7. CI runs tests — `[x]`
- Update `.github/workflows/ci.yml` to add `npm test` as a final step after build.
- Acceptance: PR with broken billing test gets blocked by CI.
- Est: 5 min.
- **Done:** CI now runs `npm run test:coverage` after Build. The 100% threshold from vitest.config.ts means a regression in either tests or billing.ts blocks merge.

---

# STAGE C — Phase 2: Resources + sessions + admin manual entry

Now we build product. All work below uses primitives from Stages A & B.

### C1. Resources table + seed — `[ ]`
- Drizzle schema:
  ```ts
  export const resourceType = pgEnum("resource_type", ["cage", "bullpen", "weight_room"]);
  export const resources = pgTable("resources", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull().unique(),  // "Cage 1", "Bullpen 2"
    type: resourceType("type").notNull(),
    sortOrder: integer("sort_order").notNull(),
    active: boolean("active").notNull().default(true),
  });
  ```
- Seed script `src/db/seed-resources.ts` adds the 10 PFA resources (5 cages, 2 bullpens, 3 weight room slots).
- Add `"db:seed": "tsx src/db/seed-resources.ts"` script.
- Acceptance: `npm run db:seed` populates 10 rows; rerunning is idempotent (upsert by name).
- Est: 45 min.

### C2. Default rates table + seed — `[ ]`
- Drizzle schema `rateDefaults` table with `type` (PK) and `ratePer30MinCents` (integer, stored in cents to avoid float).
- Seed: cage 2200, bullpen 2200, weight_room 500.
- Acceptance: rows exist in DB; helper `getDefaultRate(type)` returns correct cents.
- Est: 20 min.

### C3. Sessions table with constraints — `[ ]`
- Drizzle schema:
  ```ts
  export const sessions_billing = pgTable("sessions_billing", {  // rename to avoid auth `sessions` collision
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    coachId: text("coach_id").notNull().references(() => users.id),
    resourceId: text("resource_id").notNull().references(() => resources.id),
    startAt: timestamp("start_at", { mode: "date" }).notNull(),
    endAt: timestamp("end_at", { mode: "date" }).notNull(),
    note: text("note"),
    createdBy: text("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  });
  ```
- Add raw-SQL migration extension for: `CHECK (start_at < end_at)`, and `EXCLUDE USING gist (resource_id WITH =, tsrange(start_at, end_at) WITH &&)` (requires `CREATE EXTENSION btree_gist` — add to migration).
- Acceptance: trying to insert two overlapping sessions on the same resource fails at the DB layer.
- Est: 2 h (constraint setup is finicky).

### C4. Coach rate overrides table — `[ ]`
- `coachRateOverrides(coachId, resourceType, ratePer30MinCents)` — PK on `(coachId, resourceType)`.
- Acceptance: row insertable, retrievable, billing helper picks override over default when present.
- Est: 30 min.

### C5. Blocked times table — `[ ]`
- `blockedTimes(id, resourceId, startAt, endAt, reason, createdBy, createdAt)`.
- Same `EXCLUDE` GIST constraint as sessions — a session can't be created over a block.
- Acceptance: blocking a cage 9-11am then trying to log a session at 10am for that cage fails.
- Est: 1 h.

### C6. Server actions for admin session entry — `[ ]`
- `src/app/admin/sessions/actions.ts`:
  - `createSession(input)` — Zod-parse → `requireRole("admin")` → transaction: insert + audit log.
  - `updateSession(id, input)` — same pattern with diff capture.
  - `deleteSession(id)` — same.
- Acceptance: each action creates corresponding audit_log row.
- Est: 2 h.

### C7. Admin session entry UI — `[ ]`
- Page `src/app/admin/sessions/page.tsx`: list recent 50 sessions in a table (date, coach, resource, duration, $).
- "New session" form (coach dropdown, resource dropdown, date + start + end pickers, note, save).
- Use design-spec tokens — gold primary, table per spec, all-caps eyebrow labels.
- Acceptance: admin creates, edits, deletes a session through the UI; audit log reflects all three.
- Est: 4 h.

### C8. Integration tests — `[ ]`
- Vitest setup pointing at a Neon dev branch (cheap copy-on-write).
- Tests:
  - `createSession` rejects when caller is coach (not admin).
  - `createSession` rejects on overlapping window (DB constraint).
  - `createSession` rejects when blocked time conflicts.
  - `updateSession` writes correct diff to audit_log.
  - `deleteSession` removes session + writes audit row.
- Acceptance: 5+ integration tests passing in CI.
- Est: 3 h.

---

# STAGE D — Phase 3: Coach session logging

### D1. Coach session log form (mobile-first) — `[ ]`
- `src/app/coach/sessions/new/page.tsx`: form with date, start, end, resource select, optional note.
- Touch-friendly inputs (h-12 min on mobile per design spec).
- Submit calls `createSession` with `coachId = session.user.id` (server action enforces).
- Optimistic loading state with disabled submit (prevents double-creates on slow networks).
- Acceptance: works on iPhone Safari, creates session correctly.
- Est: 3 h.

### D2. Coach "My sessions" history — `[ ]`
- `src/app/coach/sessions/page.tsx`: paginated list of own sessions (newest first).
- Edit/delete actions enforce ownership via `requireSessionOwnership` (Phase 2 guard).
- Acceptance: coach A can't see/edit coach B's sessions even by URL guessing.
- Est: 2 h.

### D3. E2E happy-path test — `[ ]`
- `npm i -D @playwright/test`, `npx playwright install`.
- `tests/e2e/coach-flow.spec.ts`: sign in (use Auth.js dev callback or seeded test user) → log a session → see it in history → delete it.
- Run in CI on PR.
- Acceptance: test passes in CI on every PR.
- Est: 3 h.

---

# STAGE E — Phase 4: Reports

### E1. Report filters page — `[ ]`
- `src/app/admin/reports/page.tsx`: filters for coach (multi-select), date range, resource type.
- Server action `generateReport(filters)` returns aggregated rows.
- Acceptance: filtering by single coach + May date range shows that coach's May sessions only.
- Est: 3 h.

### E2. ExcelJS export — `[ ]`
- `npm i exceljs`.
- `src/lib/reports/excel.ts`: generates 2-sheet workbook (Summary, Detail) per BRAINSTORM.md:191-195.
- Triggered from server action, returned as `Buffer` → served via API route with `Content-Disposition: attachment`.
- Use cents internally → format as `$X.XX` only in the final sheet.
- Acceptance: download produces a workbook that opens in Excel/Numbers with correct totals.
- Est: 4 h.

### E3. Unit tests for report generation — `[ ]`
- Test summary aggregation: 1 coach with 3 sessions across 2 resources → correct per-resource totals + grand total.
- Test rate override application: coach with override + session on that resource type → override rate used.
- Acceptance: report tests in CI green.
- Est: 1.5 h.

---

# STAGE F — Phase 5: Schedule grid (read-only)

### F1. Schedule grid component — `[ ]`
- `src/app/admin/schedule/page.tsx`: vertical = resources (rows per design spec table), horizontal = time slots (8am-10pm, 30-min cols), one column per day in the current week.
- Each cell renders coach name if a session exists.
- Pagination/nav: prev/next week.
- Acceptance: schedule for current week renders sessions correctly with overlap visualization.
- Est: 6 h.

### F2. Real-time refresh strategy — `[ ]`
- Start with SWR polling at 30s interval (`useSWR` with `refreshInterval`).
- Defer to Phase 6+ before considering push (Pusher/Ably/server-sent events).
- Acceptance: opening schedule in 2 tabs, creating a session in tab A → tab B reflects within 30 sec.
- Est: 1 h.

---

# STAGE G — Phase 6: Schedule grid editing

### G1. Click-to-add cell — `[ ]`
- Empty cell click → modal/sheet with quick-create form (resource + start auto-filled from cell coords, coach dropdown, end time, note).
- Acceptance: click cage 2 at 3pm Tuesday → form opens with those values prefilled.
- Est: 2 h.

### G2. Click-to-edit existing session — `[ ]`
- Filled cell click → edit form with current values.
- Calls `updateSession` (existing from Phase 2).
- Acceptance: edit successfully updates and audit log captures diff.
- Est: 1.5 h.

### G3. Drag-to-move — `[ ]`
- Library: `@dnd-kit/core` (best React DnD for grids).
- Drag a session cell to a new time/resource → calls `updateSession` with new coords.
- Validate against overlap (DB constraint will reject, surface as UI error).
- Acceptance: drag works on desktop, touch-drag on tablet.
- Est: 5 h.

---

# STAGE H — Phase 7: Block-off + coach management + rate overrides

### H1. Block-off paint mode — `[ ]`
- Toggle on schedule grid: "block off mode" → click-drag selects empty cells → confirm → creates `blocked_times` rows.
- Acceptance: blocking range prevents session creation in that range.
- Est: 3 h.

### H2. Coach list page — `[ ]`
- `src/app/admin/coaches/page.tsx`: lists all users with role=coach, columns: name, email, joined date, # sessions this month, $ owed this month.
- Click row → coach detail page.
- Acceptance: list renders, sortable.
- Est: 3 h.

### H3. Per-coach rate override UI — `[ ]`
- Coach detail page → "Rate overrides" section.
- Add/edit/delete overrides via small inline form.
- Acceptance: setting override changes that coach's billing in next report.
- Est: 2 h.

### H4. Admin audit log viewer — `[ ]`
- `src/app/admin/audit/page.tsx`: filterable list of audit_log entries (by actor, entity type, date range).
- Acceptance: every action from C6/G1/G2/G3/H1/H3 visible here.
- Est: 2 h.

---

# STAGE I — Phase 8: Historical Excel import

### I1. Excel parser for source_data.xlsx — `[ ]`
- `src/lib/import/parse.ts`: reads workbook → emits raw rows `(date, resource, raw_name, start_time, end_time)`.
- Handle quirks per BRAINSTORM.md:202-206 (skip ` Template 250706` tab, trust cell dates over tab titles, collapse consecutive same-name cells into one session).
- Pure function, unit-tested.
- Acceptance: parsing `source_data.xlsx` produces expected row count and shape.
- Est: 4 h.

### I2. Name normalization + alias map — `[ ]`
- `src/lib/import/normalize.ts`: fuzzy match raw names → canonical coach.
- Build initial alias map from known variations (BRAINSTORM.md:48-58).
- Strip parentheticals to a separate `note` field.
- Acceptance: `D. Lusk`, `Lusk`, `David Lusk` all map to same canonical entry.
- Est: 3 h.

### I3. Admin import UI with dry-run — `[ ]`
- `src/app/admin/import/page.tsx`: file upload → server parses → shows preview table with "would create N sessions, M unmatched names" → confirm to commit.
- Unmatched names → "review + assign canonical name" UI before commit.
- Bulk insert in single transaction, audit-log each row with `action='create'` and `diff` containing `{ source: 'historical_import' }`.
- Acceptance: import dry-run shows accurate count, commit creates expected sessions.
- Est: 5 h.

### I4. Idempotency check — `[ ]`
- Importing same file twice should NOT duplicate. Use composite uniqueness `(coachId, resourceId, startAt, endAt, source='historical')` — drop on second insert.
- Acceptance: importing twice = same row count after both.
- Est: 1 h.

---

# STAGE J — Pre-launch hardening

### J1. Swap email to AWS SES — `[ ]`
- Sign up AWS, create SES identity for `pfacagerentals.com`.
- Verify domain via DNS records (DKIM, MAIL FROM domain) added to GoDaddy.
- Move out of SES sandbox (request production access — ~24 hour AWS turnaround).
- Swap `src/auth.ts`: use Nodemailer provider pointed at SES SMTP, sender = `noreply@pfacagerentals.com`.
- Add `AWS_SES_*` env vars to Vercel.
- Remove Resend dependency.
- Acceptance: magic-link sent to a fresh inbox lands in inbox (not spam) on first send.
- Est: 4 h.

### J2. SPF + DMARC records — `[ ]`
- GoDaddy DNS:
  - SPF TXT `@`: `v=spf1 include:amazonses.com -all`
  - DMARC TXT `_dmarc`: `v=DMARC1; p=quarantine; rua=mailto:postmaster@pfacagerentals.com; pct=100; sp=quarantine`
- Test with https://mxtoolbox.com — all green.
- Acceptance: mxtoolbox SPF + DMARC checks pass.
- Est: 30 min.

### J3. Mail-tester.com score — `[ ]`
- Send test magic-link to the address mail-tester.com gives you.
- Target: ≥ 9/10.
- Fix any flagged issues (likely link-text, list-unsubscribe header, etc.).
- Acceptance: mail-tester score ≥ 9/10.
- Est: 1 h.

### J4. PWA manifest for coach app — `[ ]`
- Add `src/app/manifest.ts` returning a Web App Manifest (name, short_name, icons, theme color = `#0a0a0a`, background = `#0a0a0a`).
- Add iOS-specific tags in layout (apple-touch-icon, status-bar-style).
- Add 192px + 512px PNG icons.
- Acceptance: "Add to Home Screen" on iPhone Safari produces a real app icon launching standalone.
- Est: 2 h.

### J5. Loading skeletons on async pages — `[ ]`
- Add `loading.tsx` files in:
  - `src/app/admin/sessions/`
  - `src/app/admin/reports/`
  - `src/app/admin/schedule/`
  - `src/app/admin/coaches/`
  - `src/app/coach/sessions/`
- Use spec'd skeleton style (gray placeholder blocks on `bg-surface`).
- Acceptance: simulating slow network shows skeletons, not blank screen.
- Est: 2 h.

### J6. Lighthouse audit on all key pages — `[ ]`
- Run Lighthouse on: sign-in, /admin, /coach, /admin/sessions, /admin/reports, /admin/schedule, /coach/sessions.
- Target ≥ 90 Performance, ≥ 95 Accessibility, ≥ 95 SEO.
- Fix flagged issues (likely: missing alt text, color-contrast on muted text, missing aria-labels on icon buttons).
- Acceptance: scorecard committed to `docs/lighthouse-2026-XX-XX.md`.
- Est: 3 h.

### J7. Privacy Policy + Terms of Service — `[ ]`
- Use Termly (https://termly.io) free generator → customize for: data we collect (email, name, session timestamps), how we use it (billing, reports), who we share with (no one), retention (7 years for tax-billing reasons), deletion request procedure.
- Pages: `src/app/privacy/page.tsx`, `src/app/terms/page.tsx` — render generated HTML inside `<AppShell>` (no auth required).
- Link from sign-in footer + every page footer.
- Add links to Google OAuth consent screen (App Domain section).
- Acceptance: pages live at `/privacy` + `/terms`, linked from sign-in, Google consent screen updated.
- Est: 2 h.

### J8. Google OAuth consent → Production — `[ ]`
- Google Cloud Console → OAuth consent screen → "Publish App".
- Google may require domain verification (Search Console TXT record at GoDaddy).
- May require app verification if scopes were sensitive (ours are not — userinfo only is fine for unverified).
- After publishing: test-users list stops mattering, any Gmail user can sign in.
- Acceptance: signed-out incognito Gmail can sign in without being on the test-users list.
- Est: 1 h (+ AWS-style waiting if domain verification needed).

### J9. Account deletion + soft-delete — `[ ]`
- Admin-only `deleteCoach(id)` action: marks user soft-deleted (sets `deletedAt`, anonymizes `name` to "Former coach", preserves billing history).
- UI in coach detail page (Stage H2): "Delete coach" button with confirmation.
- All session queries filter `deletedAt IS NULL` for active operations; reports still show historical billing.
- Acceptance: deleting a coach hides them from active lists but preserves their session rows for past reports.
- Est: 2 h.

---

# STAGE K — Launch readiness

### K1. README.md — `[ ]`
- 1-page project intro: what it is, stack overview, local dev setup (`cp .env.example .env.local`, `npm install`, `npm run db:migrate`, `npm run dev`), deploy procedure (push to main).
- Link to BRAINSTORM, design-spec, runbook.
- Acceptance: a contractor could clone, run, and deploy without asking you a question.
- Est: 1 h.

### K2. docs/runbook.md — `[ ]`
- Sections:
  - **Site down — diagnostic order:** Vercel status → Neon status → DNS at GoDaddy → CSP block in Sentry → magic-link rate limit triggered.
  - **Restore from PITR:** exact Neon dashboard procedure.
  - **Rotate a leaked secret:** procedure for rotating `AUTH_SECRET`, `AUTH_GOOGLE_SECRET`, `AWS_SES_*`, `UPSTASH_*`, `SENTRY_*`, `DATABASE_URL`.
  - **Add a new coach manually:** psql snippet to insert with role + audit.
  - **Trigger redeploy:** Vercel UI + git empty-commit fallback.
  - **Customer (coach) reports billing dispute:** how to query audit_log + session history.
  - **Onboard a new admin:** add email to `ADMIN_EMAILS`, deploy, ask them to sign in.
- Acceptance: a contractor could resolve each scenario using only this doc.
- Est: 3 h.

### K3. docs/architecture.md — `[ ]`
- One-page request-flow diagram (textual ASCII or Mermaid): Browser → Vercel Edge → Next.js server function → Auth.js or business action → Drizzle → Neon Postgres. Side branches: Sentry, Resend/SES, Upstash.
- One paragraph each on: auth strategy, billing math location, email flow, audit logging.
- Acceptance: doc exists, accurate.
- Est: 1.5 h.

### K4. Neon backup strategy — `[ ]`
- Decision: stay free tier with 24h PITR, OR upgrade Neon Launch ($19/mo) for 7-day PITR.
- If staying free: add Vercel cron job (`vercel.json` crons) that nightly runs `pg_dump` and uploads to S3/R2 — store last 30 nightly snapshots.
- Document choice in runbook.
- Acceptance: if free, one successful nightly backup visible in storage; if paid, Neon dashboard shows 7-day PITR enabled.
- Est: 2 h.

### K5. Status page — `[ ]`
- Better Stack → enable status page → custom subdomain `status.pfacagerentals.com`.
- GoDaddy DNS: CNAME `status` → Better Stack's provided value.
- Link from sign-in footer.
- Acceptance: `status.pfacagerentals.com` loads, shows uptime monitor status.
- Est: 45 min.

### K6. Final security pass — `[ ]`
- Re-run https://securityheaders.com → still A+.
- Re-run https://observatory.mozilla.org → ≥ A.
- Verify no secrets in client bundles (`grep` build output for `AUTH_SECRET`, etc.).
- Verify CSP doesn't have `'unsafe-eval'` or wildcards in prod.
- Trigger a Sentry alert; verify it arrives.
- Acceptance: all four scans/tests pass.
- Est: 1 h.

### K7. Onboarding email template for coaches — `[ ]`
- Draft email (Markdown in docs, sendable manually first time) that tells coaches: what the app does, where to sign in, what to do after first sign-in. Include screenshot or two.
- Acceptance: draft committed in `docs/coach-onboarding-email.md`.
- Est: 45 min.

### K8. Soft launch with admins only — `[ ]`
- Dad + Mom sign in, walk through schedule view + reports + manual session entry.
- Capture feedback in a GitHub issue.
- Run for 1 week before opening to coaches.
- Acceptance: admins comfortable navigating without prompts.
- Est: ongoing (1 week elapsed time).

### K9. Coach rollout — `[ ]`
- Pick 3 friendly coaches first (e.g. David Lusk, J. Tyler, Shannon).
- Send onboarding email (K7) → confirm they can sign in + log a session.
- Wait 3 days, fix anything weird.
- Open to all coaches with same email.
- Acceptance: ≥ 80% of coaches have signed in at least once within 2 weeks of full rollout.
- Est: 2-week rollout window.

### K10. Historical import committed — `[ ]`
- Once admins are confident in the live system (post-K8), run the I3 import.
- Reports now span both new live data and historical Excel data.
- Acceptance: report for a past month matches Dad's manual tally within a small margin (any discrepancy gets investigated — could be normalization edge case).
- Est: 2 h active + verification time.

---

# STAGE L — Post-launch (continuous)

These never "complete" — they're recurring practice.

### L1. Weekly Sentry triage — `[ ]`
- Friday: open Sentry → review week's errors → fix or dismiss with note.

### L2. Monthly billing reconciliation — `[ ]`
- Last day of month: admin pulls report → compares to a sample of coach memory → confirms accuracy.

### L3. Quarterly dependency updates — `[ ]`
- Every 3 months: `npx npm-check-updates -u` → review → test → deploy. Especially Auth.js (we're on beta — switch to stable when it lands).

### L4. Yearly security review — `[ ]`
- Re-run security headers scan, observatory, mail-tester, Lighthouse. Rotate `AUTH_SECRET`. Audit `ADMIN_EMAILS` list.

---

# Total estimate

| Stage | P0 hours |
|---|---|
| A — Guard rails | ~3 h |
| B — Data foundation | ~7 h |
| C — Phase 2 (sessions) | ~13 h |
| D — Phase 3 (coach log) | ~8 h |
| E — Phase 4 (reports) | ~8.5 h |
| F — Phase 5 (grid read) | ~7 h |
| G — Phase 6 (grid edit) | ~8.5 h |
| H — Phase 7 (block + coaches + rates) | ~10 h |
| I — Phase 8 (import) | ~13 h |
| J — Pre-launch hardening | ~17 h |
| K — Launch readiness | ~14 h |
| **Total to launch** | **~108 h** |

Plus L (post-launch ongoing).

---

# Notes on what's deliberately not here

- **No multi-tenancy.** This is one organization. If PFA ever wants white-label or franchise expansion, that's a v2 rewrite, not a Phase 9 task.
- **No SOC 2 / HIPAA / PCI.** No regulated data flows through this app. If credit cards ever land here (subscription payments?), revisit.
- **No on-call rotation.** Bus factor accepted at 1 (Jacob) for v1; runbook + Dad-readable docs mitigate.
- **No queue infrastructure (BullMQ, etc.).** All actions are synchronous request-response. If we ever add background work (e.g. monthly auto-invoicing), introduce queues then.
- **No internationalization.** English-only for the foreseeable future.
- **No A/B testing or feature flags.** YAGNI for a 30-user internal tool.
