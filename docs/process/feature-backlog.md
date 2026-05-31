# Feature backlog

Lightweight coordination tracker. This chat (the coordination chat) keeps this
file fresh so we don't double-spec features or lose track of what's in flight in
parallel backend chats.

Not a roadmap. Not a billing log (Jacob has a separate tracker). Just: what's
queued, what's running in another chat, what shipped, what's blocked.

---

## In flight (handed off to a fresh chat)
{{When a handoff prompt is fired, move it here with a date + short title.}}

_None._

## Queued (planned, prompt drafted but not handed off yet)

- **Re-enable + update E2E test for multi-slot UX** *(P2, ~1-2h)* — `tests/e2e/coach-flow.spec.ts` is `if: false` in ci.yml since 2026-05-26 (commit `d2a9734`). The form now defaults to multi-slot mode (start = now-rounded, end = +1hr → 2 notecards), so `input[name=note]` no longer exists at the page level. Fix: either drive the multi-slot UI (per-slot inputs in `SessionSlotsList`) or shrink the range to a single 30-min slot before filling. Then remove the `if: false` line in `.github/workflows/ci.yml`. See HANDOFF.md quirks > SlotLengthToggle.

- **CI hardening: fail loudly when `INTEGRATION_DATABASE_URL` is unset on main** *(P3, ~10 min)* — `.github/workflows/ci.yml` integration + e2e jobs currently `exit 0` if the secret is missing (silent skip). Now that the secret is provisioned (2026-05-26), regression risk is "secret gets accidentally unset and we don't notice." Fix: add a smoke check that fails main builds if the secret is missing, while keeping the skip behavior for forks (`if: github.repository == 'Jacobmagna/pfa-cage-rentals'` guard or similar).

## Ideas (not yet scoped)

- **Online rental-credit report** — Online sessions are $0 on website but Dad still needs a per-coach summary ("Coach X did N online lessons this period = $Y in rental credits") to subtract from his off-website payouts. Detail rows already carry an `isOnline` flag and the Summary row has `onlineSessions` — wire a dedicated "rental credits owed" surface when Dad asks.

## Shipped (commit SHA + date)

### Deep-sweep audit (2026-05-25 → 2026-05-26) — all 7 batches closed
Source doc: [audit-2026-05-25.md](audit-2026-05-25.md). Explicit skips documented in the "Scope — out" sections of each batch.

- **Batch 1** — Snapshot rule fix on 4 admin surfaces (P0 money bug). `/admin`, `/admin/payments`, `/admin/coaches`, `/admin/coaches/[id]` now read `sessions_billing.ratePer30MinCents` directly; HANDOFF snapshot claim is now accurate.
- **Batch 2** — Global error + 404 pages. `global-error.tsx`, `error.tsx`, `not-found.tsx` at root + per-section `error.tsx` under `/admin` and `/coach`. Sentry capture wired. Verified end-to-end via deliberate throw.
- **Batch 3** — Design token migration. Raw `emerald`/`sky`/`amber`/`red` replaced with `success`/`warning`/`danger`/`gold` semantic tokens app-wide; `rounded-xl` downgraded to `rounded-lg` on functional UI per spec.
- **Batch 4** — `<ConfirmDialog>` extracted from delete-coach pattern with simple + typed-confirmation variants; 5 `window.confirm()` callers replaced; 4 missing `loading.tsx` files added.
- **Batch 5** — Mobile polish sweep. Row icon-buttons bumped at mobile breakpoint, "rotate device" hint on admin tables, Use-type select chevron fix, reports table column consolidation 9 → 7 cols.
- **Batch 6a** — Integration tests for money + irreversibility paths: payment-actions, rate-override-actions, rate-defaults-actions, user-actions (delete + merge). Snapshot-rule regression test included.
- **Batch 6b** — Integration tests for the remaining server-action files: audit (`shallowDiff`), block-actions, import-actions, handles-actions. Plus E9 fix (executeCommitPlan rate=0 silent failure).
- **Batch 7** — Audit closeout. Deleted `updateOwnProfile` placeholder RPC; TZ-aware month boundaries in `lib/reports/filters.ts` + `lib/audit/filters.ts`; archived seed/backfill scripts to `scripts/archive/` with README; pushed `revalidatePath` into coach-side actions; stale Zelle copy fixed; ERROR_COPY fallback + Auth.js codes; N=1 hint hidden; schedule-grid legend cadence fix; 5 dead Next.js scaffold SVGs removed.

### Earlier work (this session, before audit)
- 2026-05-25 — Variable rates + online flag. Per-coach overrides snapshotted onto each session row + new `is_online` flag forces $0 rental + Excel rates seeded + 345 historical sessions backfilled. Admin can edit defaults from /admin/settings.
- `83c7dff` 2026-05-25 — Drop coach payments UI; variable rates + online flag; remove Venmo
- `67a40ae` Multi-slot batch session creation
- `304be7e` Back link on /admin/sessions and /admin/import
- `1ab5635` Allow synthetic-target merges
- `e62d340` Hide coach $ amounts; merge synthetic import coaches
- `852bf01` Team-rental flag on sessions

## Blocked / parked

- **K5 status page** — post-launch nice-to-have; Better Stack + GoDaddy CNAME pending.
- **K9 coach rollout** — gated on Jacob picking first 2–3 friendly coaches (David Lusk is candidate #1).
- **Sales/branding push** — owned by a separate chat per Jacob's call; not this one.
- **LLC formation** — Jacob to verify "Magna Software LLC" availability before forming.
