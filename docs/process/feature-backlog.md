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

- **Audit fix batches** (2026-05-25) — Deep sweep produced [audit-2026-05-25.md](audit-2026-05-25.md). 7 batched handoffs ready, sequenced P0 → P2:
  1. Snapshot rule fix on 4 admin surfaces *(P0, real money bug — `/admin/payments` shows divergent totals from reports)*
  2. Global error + 404 pages *(P0, ~1-2h)*
  3. Design token migration — replace raw emerald/sky/amber/red with semantic tokens *(P0, ~3-4h)*
  4. ConfirmDialog extraction + missing loading skeletons *(P1, ~2-3h)*
  5. Mobile polish sweep *(P1, ~2-3h)*
  6. Test coverage backfill on critical paths *(P1, ~5-10h)*
  7. Cleanup batch — placeholders, stale copy, OG metadata, dead assets *(P2, ~2-3h)*

- **Re-enable + update E2E test for multi-slot UX** *(P2, ~1-2h)* — `tests/e2e/coach-flow.spec.ts` is `if: false` in ci.yml since 2026-05-26 (commit `d2a9734`). The form now defaults to multi-slot mode (start = now-rounded, end = +1hr → 2 notecards), so `input[name=note]` no longer exists at the page level. Fix: either drive the multi-slot UI (per-slot inputs in `SessionSlotsList`) or shrink the range to a single 30-min slot before filling. Then remove the `if: false` line in `.github/workflows/ci.yml`. See HANDOFF.md quirks > SlotLengthToggle.

- **CI hardening: fail loudly when `INTEGRATION_DATABASE_URL` is unset on main** *(P3, ~10 min)* — `.github/workflows/ci.yml` integration + e2e jobs currently `exit 0` if the secret is missing (silent skip). Now that the secret is provisioned (2026-05-26), regression risk is "secret gets accidentally unset and we don't notice." Fix: add a smoke check that fails main builds if the secret is missing, while keeping the skip behavior for forks (`if: github.repository == 'Jacobmagna/pfa-cage-rentals'` guard or similar).

## Ideas (not yet scoped)

- **Online rental-credit report** — Online sessions are $0 on website but Dad still needs a per-coach summary ("Coach X did N online lessons this period = $Y in rental credits") to subtract from his off-website payouts. Detail rows already carry an `isOnline` flag and the Summary row has `onlineSessions` — wire a dedicated "rental credits owed" surface when Dad asks.

## Shipped (commit SHA + date)

- 2026-05-25 — Variable rates + online flag (this commit). Per-coach overrides snapshotted onto each session row + new `is_online` flag forces $0 rental + Excel rates seeded + 345 historical sessions backfilled. Admin can edit defaults from /admin/settings; override editor on /admin/coaches retains its "future sessions only" copy. Builds on `83c7dff` which dropped the coach-payments UI + Venmo and laid the schema groundwork.
- `83c7dff` 2026-05-25 — Drop coach payments UI; variable rates + online flag; remove Venmo
- `67a40ae` 2026-05-?? — Multi-slot batch session creation
- `304be7e` 2026-05-?? — Back link on /admin/sessions and /admin/import
- `1ab5635` 2026-05-?? — Allow synthetic-target merges
- `e62d340` 2026-05-?? — Hide coach $ amounts; merge synthetic import coaches
- `852bf01` 2026-05-?? — Team-rental flag on sessions

## Blocked / parked

- **K5 status page** — post-launch nice-to-have; Better Stack + GoDaddy CNAME pending.
- **K9 coach rollout** — gated on Jacob picking first 2–3 friendly coaches (David Lusk is candidate #1).
- **Sales/branding push** — owned by a separate chat per Jacob's call; not this one.
- **LLC formation** — Jacob to verify "Magna Software LLC" availability before forming.
