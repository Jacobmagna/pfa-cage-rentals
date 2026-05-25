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

_None._

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
