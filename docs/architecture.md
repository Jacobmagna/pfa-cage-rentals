# PFA Cage Rentals — architecture

One-page tour of how a request flows through the stack and where the
load-bearing pieces live. Read [README.md](../README.md) first if
you're new; this doc assumes you know what the app does.

## Request flow

```
                       ┌─────────────────────────────────────┐
                       │              Browser                │
                       │  (Chrome / Safari / mobile PWA)     │
                       └──────────────┬──────────────────────┘
                                      │  HTTPS
                                      ▼
                       ┌─────────────────────────────────────┐
                       │           Vercel Edge               │
                       │  (TLS termination, CDN, routing)    │
                       └──────────────┬──────────────────────┘
                                      │
                                      ▼
                       ┌─────────────────────────────────────┐
                       │     Next.js 16 server function      │
                       │   ┌────────────────────────────┐    │
                       │   │  React Server Component    │    │
                       │   │  or "use server" action    │    │
                       │   └─────────────┬──────────────┘    │
                       │                 │                   │
                       │     ┌───────────┼───────────┐       │
                       │     ▼           ▼           ▼       │
                       │ ┌────────┐ ┌────────┐ ┌─────────┐   │
                       │ │ authz  │ │  Zod   │ │ billing │   │
                       │ │guard   │ │ schema │ │  math   │   │
                       │ └───┬────┘ └────────┘ └─────────┘   │
                       │     │                               │
                       │     ▼                               │
                       │ ┌─────────────┐  ┌───────────────┐  │
                       │ │  Auth.js    │  │   Drizzle     │  │
                       │ │  (session   │  │  (SQL builder │  │
                       │ │   cookie)   │  │   + types)    │  │
                       │ └──────┬──────┘  └───────┬───────┘  │
                       └────────┼─────────────────┼──────────┘
                                │                 │
                  ┌─────────────┴─────────────────┴──────────┐
                  │                                          │
       ┌──────────▼──────────┐  ┌──────────▼──────────┐
       │  Neon Postgres      │  │   Side effects      │
       │  ───────────────    │  │   ──────────────    │
       │  users, sessions,   │  │   • Sentry  (errors │
       │  accounts,          │  │     + perf traces)  │
       │  resources,         │  │   • Resend  (magic- │
       │  rate_defaults,     │  │     link emails)    │
       │  coach_rate_        │  │   • Upstash Redis   │
       │     overrides,      │  │     (magic-link     │
       │  sessions_billing,  │  │     rate limiting)  │
       │  blocked_times,     │  │                     │
       │  audit_log,         │  └─────────────────────┘
       │  verification_      │
       │     tokens          │
       └─────────────────────┘
```

Every authenticated request runs the same shape: server component or
`"use server"` action → `requireRole`/`requireSession` from
`src/lib/authz.ts` → Zod-parse the input → call into
`src/lib/server/*` (internal actions) which talk to Drizzle → Neon
returns rows → render or revalidate. Mutations also append to
`audit_log` via the helper in `src/lib/audit.ts` (sequential, not
transactional — see below).

## Auth strategy

Auth.js v5 with the Drizzle adapter, using a database session strategy
so sessions live in Postgres (table: `sessions`, keyed by
`sessionToken`). Two providers:

1. **Google OAuth** — primary path for admins and most coaches.
   `allowDangerousEmailAccountLinking` is on so a coach who first
   used a magic-link can later sign in with Google and have the
   account auto-linked by matching email.
2. **Resend magic-link** — fallback for anyone without a Google
   account. Sender is `noreply@pfacagerentals.com` on PFA's own
   Resend account (separate from the doc-insured account).

Admins are gated by a hardcoded allowlist in
`src/lib/admin-emails.ts` (Jacob, Dad, Mom). The `createUser` event
in `src/auth.ts` checks the allowlist and promotes the row to
`role='admin'` on first sign-in. Every server route calls
`requireRole("admin")` or `requireSession()` as its first line; both
redirect to `/` on failure. Public legal pages use `PublicShell`
(auth-agnostic) so the OAuth consent screen's privacy/terms links
load for signed-out visitors.

J9 soft-delete: `users.deletedAt` non-null = anonymized account.
Active-coach surfaces filter `isNull(users.deletedAt)`; reports and
audit log keep showing "Former coach" so historical context survives.

## Billing math location

All currency arithmetic lives in `src/lib/billing.ts`. The unit test
file has a 100% coverage gate enforced in CI so any change has to
prove it doesn't silently introduce a float-drift or off-by-one
issue. Two key invariants:

- **Cents only.** The DB stores `ratePer30MinCents` as an integer; the
  UI converts at the form boundary. JS float math never touches a
  dollars value with more than 2 decimal places.
- **Snapshot at billing time.** `sessions_billing` rows do not FK to
  the override table. The rate used at session creation is implicitly
  preserved by the audit trail — changing a coach's override today
  does not retroactively re-bill their past sessions. The override
  table only affects rows created from that point forward.

The single function `chargeForSession` resolves override-vs-default
and computes `(slots × ratePer30MinCents)` for any (coach, resource
type, start/end) tuple.

## Email flow

```
admin/coach types email at /
  → Resend provider validates rate limit (src/lib/ratelimit.ts via Upstash)
  → if allowed: Resend API sends magic-link from noreply@pfacagerentals.com
  → recipient clicks link → /api/auth/callback/resend?token=...
  → Auth.js verifies + creates session row + drops the verification token
  → redirect to /admin or /coach based on role
```

Rate limits: 5/hr per email, 10/hr per IP (sliding window). Both
limits live in Upstash Redis with the `rl:magic-link:*` key prefix.
The lib gracefully no-ops if `UPSTASH_*` env vars are missing so
local dev runs without them (the env validator in `src/lib/env.ts`
will flag missing vars to `/api/health` regardless).

SPF + DMARC live as TXT records at GoDaddy DNS for
`pfacagerentals.com`. Resend's domain verification adds SPF; DMARC is
`v=DMARC1; p=quarantine; pct=100; sp=quarantine` without a `rua`
mailbox (we don't process aggregate reports).

## Audit logging

Every billing-relevant mutation appends a row to `audit_log`:
- `entityType` — `"session"`, `"block"`, `"rate_override"`, `"user"`
- `entityId` — surrogate UUID, or composite (e.g.
  `"<coachId>:<resourceType>"` for rate overrides)
- `action` — `"create"`, `"update"`, `"delete"`
- `diff` — JSONB: `{ after }` for creates, `{ before }` for deletes,
  changed-keys-only `{ before, after }` for updates
- `actorUserId` — FK to `users`

The helper in `src/lib/audit.ts` writes the row in the same DB call
as the underlying mutation when possible. Because neon-http has no
transactions, the audit insert is **sequential** rather than
transactional — if the mutation succeeds but the audit insert fails,
`safeLogAudit` Sentry-captures it and continues. Detection is via
LEFT JOIN audit_log when investigating disputes. If true atomicity
becomes required (compliance), switch to neon-serverless WebSocket
driver and wrap in `db.transaction`.

The audit log is append-only — there is no UPDATE or DELETE path. The
admin UI at `/admin/audit` filters and paginates the table; that's
the only read path.
