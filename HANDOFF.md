# Handoff prompt — paste into next session

**This is the entry point for fresh Cage Rentals Maintenance / Iteration chats.** Read this top-to-bottom before doing anything. If context fills in the active chat, a new chat reading this should be able to pick up without losing anything load-bearing.

Continuing the PFA Cage Rentals app in a fresh context. I'm Jacob — engineering for my dad's PFA Baseball training facility (Excel-replacement scheduling/billing app). Hooks log time to `worklog/sessions.jsonl`; surface a visible "Cage Rentals tracking active" line in your first response so I can see hooks fired.

## Commercial framing (as of 2026-05-26)

- **The $700 fixed-price base build is CLOSED** — locked at 2026-05-25 09:30 PDT. The "Cage Rentals Base" worklog tab is frozen.
- **All work from 2026-05-25 09:30 onward is billed hourly at $150/hr** and tracked in the **"Cage Rentals — Iteration"** worklog tab. This is what your current session is logging into.
- Tier 1 product work (contact book, tryouts form, team formation, uniform helper) is a **separate engagement at $200/hr** and lives in a different repo (`pfa-tier-one`). If the user starts asking for Tier 1 work in this chat, stop and tell them to switch to the pfa-tier-one folder per the SessionStart hook reminder.
- See `docs/proposals/cage-rentals-maintenance.md` for the canonical scope/billing doc shared with Dad + Mom.
- For asks > ~3 hours of work, give a rough estimate before charging in. Below that, just execute and bill.

## Before doing anything

1. Read project memory (auto-loaded via `MEMORY.md` at `/Users/jacobmagna/.claude/projects/-Users-jacobmagna-coaches-cage-ai/memory/`) — gives you stack, admins, design direction, workflow, product decisions.
2. Re-read `docs/process/production-checklist.md` (canonical work doc, stages A through L by dependency order).
3. Re-read `docs/reference/design-spec.md` before any UI work (dark + warm gold, Vercel/Linear vibe).
4. Skim `docs/reference/architecture.md` for the 1-page request-flow + auth/billing/email/audit deep dive.
5. `docs/operations/runbook.md` is the on-call doc — restore from backup, secret rotation, billing-dispute audit queries.
6. Skim `BRAINSTORM.md` if Stage I work resurfaces.

## Project one-liner

Replacing Dad's shared-Excel cage-rental tracker with a real web app at `pfacagerentals.com`. Next.js 16 + React 19 + Tailwind 4 + Drizzle + Neon Postgres + Auth.js v5 (Google + Resend) + Sentry + Upstash rate-limiting + Vitest + Playwright + @dnd-kit/core + ExcelJS. Deployed on Vercel under Dad's account. Three admins (Jacob, Dad, Mom) auto-promoted on first Google sign-in. **App is LIVE with real historical data + real coaches incoming.**

## Where the build is

**Stage J: 100% complete.**

**Stage K-code: complete.**

**Stage K-launch: K8 + K10 done; K9 + K5 pending.**
- **K8 admin soft-launch (2026-05-26):** Dad + Mom walked the app. Surfaced two real asks — see "Post-K8 feature shipped this session" below.
- **K10 historical import:** Live on prod. 345 sessions, 40 → 34 coaches (after 6 consolidation merges), 8 team-rental sessions flagged. Verified against Dad's tally during walkthrough. R2 backup taken before commit (run 26383162976).
- **K9 coach rollout:** Not started. `docs/operations/coach-onboarding-email.md` is the template. Plan is 2–3 friendly coaches first, then expand.

**Post-launch features shipped this session (newest first):**

- **Audit closeout (Batch 7 / 2026-05-26).** Final sweep on the 2026-05-25 deep-sweep audit (see `docs/process/audit-2026-05-25.md`). All seven shipped batches now closed:
  - **Batch 1** snapshot rule on admin surfaces (P0)
  - **Batch 2** global error + 404 pages (P0)
  - **Batch 3** design-token migration + rounded-lg sweep (P0)
  - **Batch 4** ConfirmDialog + loading skeletons (P1)
  - **Batch 5** mobile polish sweep (P1)
  - **Batch 6a/6b** test coverage backfill (P1) — billing + integration coverage on payment-actions, rate-overrides, handles, audit, block, import, user-actions
  - **Batch 7** (this batch) — deleted unused `updateOwnProfile` placeholder RPC; TZ-aware month boundaries in `lib/reports/filters.ts` + `lib/audit/filters.ts` via `pfaMonthStart`/`pfaMonthEnd` + `parsePfaInput`; archived `scripts/seed-excel-overrides.mts` + `scripts/backfill-rate-cents.mts` to `scripts/archive/` with a README; pushed `revalidatePath("/coach", "/coach/sessions")` into the public coach-side mutation actions themselves (not just the form-action wrappers); fixed stale Zelle copy in `org-settings-card`; added an ERROR_COPY fallback + two extra Auth.js error codes (OAuthAccountNotLinked, Verification) on the sign-in page; hid the "N sessions" hint when N=1; promoted the schedule-grid legend's "Drag a session to move it" instruction to its own `<p>` for screen-reader cadence; deleted 5 dead Next.js scaffold SVGs in `public/`. The explicitly-skipped items (`<SettingsCard>` primitive, `as any` in parse.ts, OG metadata, `safeLogAudit` dedupe, neon-http → neon-serverless migration) are documented in the audit's "Scope — out" section.

- **Variable per-coach rates + Prepaid online lesson flag.** `sessions_billing` gained `rate_per_30_min_cents` (snapshotted at write time) and `is_online` (forces rate to $0). Excel-discounted coaches seeded into `coach_rate_overrides`: Fry/Iniguez/Gomez/Parker/Sanchez/Leon @ $17 cage, David Lusk @ $15, Gonzalez @ $10. `rate_defaults.weight_room` corrected from $5 to $7. All 345 historical sessions backfilled to their correct Excel rates. The coach + admin session forms swap the old stacked checkboxes for a `SessionFlagsRow` pill row (`Team rental` admin-only, `Prepaid online lesson` everywhere, `PFA-referred` everywhere). Reports + Excel export + `/admin/sessions` all read the snapshotted rate — they **never** recompute from current overrides. Admin can edit default rates from `/admin/settings`; coach-override editor on `/admin/coaches/[id]` already had the "future sessions only" copy.
- **Multi-slot batch session creation** (`67a40ae`). David Lusk's ask: he books 4+ hours of back-to-back 30-min lessons; making him do that one-at-a-time killed the Excel parity. Now the coach + admin session forms have a "Slot length" toggle (30 / 60 min). When the time range exceeds one slot, the single Note + TeamRental fields swap for N notecards (one per generated slot with its own optional note + team-rental checkbox). Submit calls a new `createSessionsBatch` action that pre-validates every slot (block + overlap + intra-batch self-overlap) then bulk-inserts in one Postgres statement (atomic at the DB layer). Single-slot creates fall through to the existing form-action path. Edit mode is single-session as before. Lives in `src/lib/server/session-actions.ts` (`createSessionsBatchInternal`), `src/app/_components/slot-length-toggle.tsx`, `src/app/_components/session-slots-list.tsx`.
- **Back link on `/admin/sessions` and `/admin/import`** (`304be7e`). The two outliers missing the "← Back" affordance that the other admin pages had.
- **Allow synthetic-target merges** (`1ab5635`). Removed the `!r.isSynthetic` filter on the merge dialog target list — needed for consolidating PFA Travel sub-groups during the import cleanup.
- **Hide coach $ amounts + synthetic-coach merge** (`e62d340`). Two things in one commit:
  - Coach surfaces no longer show ANY dollar amounts. `/coach` landing has Sessions + Hours tiles instead of Sessions + Total. `/coach/sessions` rows show duration only. Decision: rates are variable per coach and per resource; Dad invoices manually. V2 will add `/coach/invoices`. See `project_coach_rate_visibility.md` for the V2 path.
  - `/admin/coaches` shows an "Imported" pill + Merge button on synthetic users (`@imported.local` emails). Merge re-points every `sessions_billing.coach_id` to a real coach, drops empty rate overrides, hard-deletes the synthetic. Audit log captures source-delete + sessions-moved count. Critical for the post-K9 workflow: when a real coach signs up, scan `/admin/coaches` for an Imported badge matching their name → Merge.
- **Team-rental flag** (`852bf01`). New `is_team_rental boolean not null default false` on `sessions_billing`. Checkbox in every session create/edit form. Gold "Team" pill renders next to the coach name on every display surface (sessions table, schedule grid block, reports preview, Excel detail, coach history). Filter on `/admin/sessions`. Lets us name team-rental sessions cleanly (just "Cesar Hernandez") and signal the rental status separately. Used to clean up the import: 8 historical sessions across Cesar / Mark Wendell / Fabian / Jung / Juno got flagged via one-shot SQL.
- **Sessions filter system + reports MultiSelect** (`faaf007`). `/admin/sessions` now has Coach / Resource / Use-type / Date-range / Team-rental filters. URL-state, defaults to last 14 days, capped at 500 rows. New shared `MultiSelect` component (popover, search, hidden-input submission for native GET form). `/admin/reports` coach checkboxes swapped for the same MultiSelect — ready for 30+ coaches.

Recent commits (newest first):
- `67a40ae` Multi-slot batch session creation
- `304be7e` Back link on /admin/sessions and /admin/import
- `1ab5635` Allow synthetic-target merges
- `e62d340` Hide coach $ amounts; merge synthetic import coaches
- `852bf01` Team rental flag on sessions
- `faaf007` Filter /admin/sessions; MultiSelect across admin filters
- `9165af2` Coach availability calendar under session form
- `ed5f0af` Time inputs: strict 30-min dropdown 8 AM – 10 PM
- `4e643c5` J4e batch 4: empty-state sweep + J4e closeout

```
J1   PFA Resend account               [x]
J2   SPF + DMARC                      [x]
J3   Mail-tester (10/10)              [x]
J4   PWA manifest                     [x]
J4b  Server TZ display                [x]
J4c  Drag self-overlap snap-back      [x]
J4d  Sign-in logo + wordmark          [x]
J4e  UI polish pass                   [x]
J4f  End-to-end TZ rigor              [x]
J5   Loading skeletons                [x]
J6   Lighthouse audit                 [x]
J7   Privacy + Terms                  [x]
J8   OAuth → production               [x]
J9   Account deletion + soft-delete   [x]

K1   README                           [x]
K2   docs/operations/runbook.md       [x]
K3   docs/reference/architecture.md   [x]
K4   Nightly R2 backup                [x]   (verified live)
K5   Status page                      [ ]   parked post-launch
K6   Security pass                    [~]   external scans pending
K7   Onboarding email template        [x]
K8   Soft launch w/ admins            [x]   walkthrough done 2026-05-26
K9   Coach rollout                    [ ]   not started
K10  Historical import committed      [x]   345 sessions in prod
```

## Workflow conventions (active)

- **Push direct to main.** No PR ceremony. Pre-commit hook runs lint-staged eslint + `tsc --noEmit`; CI runs lint, typecheck, build, `npm run test:coverage` (100% threshold on billing.ts) AND `npm run test:integration` (60 tests against the integration Neon branch). The E2E job is temporarily disabled in `.github/workflows/ci.yml` (`if: false`) — its single spec is stale relative to the multi-slot session form. Re-enable when updating the spec. `INTEGRATION_DATABASE_URL` is set in repo secrets (2026-05-26) pointing at a Neon branch off prod; `setup.ts` refuses to run if it equals `DATABASE_URL`.
- **Deep-sweep verification every ~3–4 items.** Recent sweeps already landed in batched commits.
- **For product items**, give a pre-scope rundown before executing so Jacob can correct scope. Use `AskUserQuestion` for real design calls; otherwise pick sensible defaults and call them out.
- **Browser-verify every UI change** via the preview tool (`.claude/launch.json` has `autoPort: true` so dev preview falls back to a free port when 3000 is held by another project). Dev session cookie pattern: write a small `*.mts` script that loads `.env.local` via dotenv, inserts an Auth.js sessions row, then `document.cookie = "authjs.session-token=..."`. **Always cleanup the dev session + any fixture data + delete the `.mts` script before commit.**
- **`.env.local` DATABASE_URL points at PROD.** Jacob confirmed this 2026-05-25. A dev-session script + any `npx tsx`-style one-shot mutates production data. Use carefully; prefer scoped WHERE clauses + a preview SELECT before any UPDATE/DELETE.
- **WARN: the AppShell has its own Sign Out form**, so `button[type=submit]` selectors hit BOTH the page submit AND sign-out — match by button text instead.
- **WARN: synthetic `cell.click()` in preview_eval won't trigger React form-actions or @dnd-kit drags.** For drags/clicks, fire a real `pointerdown` → `pointerup` → `click` sequence. For form submits use `form.requestSubmit()` and the `proto.call(input, value)` pattern to set React-controlled inputs.
- **WARN: TimeSelect synthetic events don't always propagate.** Setting a `<select name="endTime">` via prototype + dispatching `change` doesn't reliably update the React-controlled state in preview_eval. Trust static reasoning + DB-state verification for multi-slot tests rather than fighting the synthetic-event layer.
- **WARN: when running dev preview, the `.next/dev/` folder gets auto-generated route types that occasionally have invalid TypeScript.** If pre-commit `tsc` fails on `.next/dev/types/routes.d.ts`, just `rm -rf .next/dev` and retry. Hit this three times now.
- **WARN: preview_screenshot captures at 800×500 max** but the page renders at the requested viewport. On widths > 800 the screenshot scales down which makes labels unreadable. Either resize the preview to ≤800 wide before screenshotting, or rely on DOM-state assertions via `preview_eval` for verification.
- **WARN: preview_resize uses preset="desktop" but doesn't actually apply.** Use `width` + `height` props explicitly.
- **WARN: dnd-kit synthetic events.** dnd-kit's PointerSensor uses native listeners that don't fully trust dispatched events. Drag interactions can't be cleanly tested via preview_eval. Verify via static reasoning + DOM state + manual testing instead.
- **WARN: neon-http returns timestamps as strings** for SQL aggregates (e.g. `max(ts)`). Type as `string | null` and `new Date(value)` in the caller before formatting.
- **WARN: React Compiler / react-hooks/refs rule** forbids reading `ref.current` during render. The cache-by-signature pattern (SessionSlotsList) reads from props instead — if you ever need cross-render caching, lift to parent state rather than refs.
- After cleaning up test data + dev sessions, commit + push.

## Important quirks (load-bearing in current codebase)

- **Rate snapshot rule.** Every `sessions_billing` row carries its own `rate_per_30_min_cents`, stamped at creation in `src/lib/server/session-actions.ts:resolveRateCents`. EVERY billing surface — reports, Excel export, `/admin/sessions`, `/admin` dashboard tiles, `/admin/payments` per-coach balances, `/admin/coaches` month-to-date, `/admin/coaches/[id]` lifetime owed — reads that column directly via `totalFromSnapshot(startAt, endAt, ratePer30MinCents)`. Rates are NEVER recomputed from current overrides on the read path; `coach_rate_overrides` is consulted only at session WRITE time (and for the rate-override editor UI). Renegotiating a coach's override only changes FUTURE bookings. The admin edit path re-stamps the rate ONLY when `(coachId, resourceId, isOnline)` changes. Online sessions (`is_online = true`) always snapshot at $0 — PFA collects from the client directly and nets the rental against the coach payout off-app.
- **neon-http has no transactions.** Mutation-then-audit is sequential. `safeLogAudit` Sentry-captures audit failures. Detectable via LEFT JOIN audit_log. Multi-slot batch insert uses a single drizzle `.values([...])` statement which Postgres treats atomically — either all rows commit or the statement fails. Pre-validation catches conflicts; the remaining race window is caught by EXCLUDE and translates to SessionOverlapError. If true mutation+audit atomicity is needed (compliance), switch to neon-serverless WebSocket driver.
- **useType ("hitting" | "pitching")** is required on cages, must be null for bullpens/weight rooms. Enforced app-layer in `src/lib/server/session-actions.ts` (both single + batch paths).
- **Block-vs-session overlap** is enforced app-layer in createSession, createBlock, AND createSessionsBatch. Block-vs-block + session-vs-session are DB-level via btree_gist EXCLUDE.
- **Revalidation invariant:** every PUBLIC server action that mutates calls `revalidatePath` for the affected surfaces.
- **TZ-aware EVERYTHING.** `src/lib/timezone.ts` is the single source of truth. `PFA_TIMEZONE = "America/New_York"`. Canonical helpers:
  - Display: `formatPfaDate`/`Time`/`Weekday`/`DateLong`/`DateMedium`/`MonthYear`/`pfaParts`
  - Form parsing: `parsePfaInput(dateStr, timeStr)` (alias for `pfaWallClockToUtc`)
  - Grid math: `pfaHour(d)`, `pfaMinute(d)`, `pfaWallClockAt(d, hour, minute)`
  - Bucketing: `pfaDayStart`/`pfaDayEnd`/`pfaMonthStart`/`pfaMonthEnd` — DST-safe boundaries
  - Any `new Date("...T...")`, `getHours()`, `setHours()`, or `toLocale*` without explicit `timeZone: PFA_TIMEZONE` is a regression — use the helpers.
- **`sessions_billing.source` column** distinguishes provenance: `NULL` for manually-entered sessions, `"historical_import"` for I3 imports. Used by I3's pre-flight dedupe + bulk team-rental flagging. Don't set this column from any path other than the historical-import flow.
- **`sessions_billing.is_team_rental` column** — boolean default false. Coach view + admin view show a gold "Team" pill next to the coach name when set. Filter on `/admin/sessions`. Excel export gets a "Team Rental" column. NOT a billing modifier — the coach still gets billed at their rate.
- **Audit log entityId convention varies:** session/block use surrogate UUIDs; rate_override uses composite `${coachId}:${resourceType}`; user mutations use the user's own id with `entityType: "user"`. Multi-slot batch insert logs a single entry keyed to the first inserted id, with `{ batch: true, count, sessionIds: [...] }` in the after-payload.
- **React 19 lint rules** flag (a) ref reads during render — use props or lifted parent state instead, (b) setState in effect for prop transitions — use the "store prevProp in state, conditionally setState during render" pattern.
- **suppressNextClickRef** in `schedule-grid.tsx` paint UX must be cleared on every pointerdown.
- **"use server" files** expose every async export as a public RPC endpoint. Keep public actions thin authz wrappers (`requireRole("admin")` + `revalidatePath`); internal logic lives in `src/lib/server/`.
- **Direct-call vs form-action**: public delete actions take explicit typed args; public create/upsert take `input: unknown` because they're called from form-action wrappers with FormData. Internal actions always take `input: unknown` and Zod-parse. The new `createSessionsBatch` (admin) + `logOwnSessionsBatch` (coach) take a JSON payload directly — called via `startTransition` from the client form, not through the form-action layer.
- **PublicShell vs AppShell.** `/privacy` and `/terms` use `PublicShell` (auth-agnostic — must load for signed-out visitors since Google's OAuth consent screen links here). Don't replace with AppShell.
- **AppShell now lives in route-segment layouts** (`src/app/admin/layout.tsx`, `src/app/coach/layout.tsx`) rather than per-page imports — lets `loading.tsx` render INSIDE the shell. Pages return `<>{...}</>`.
- **TimeSelect** is the canonical 30-min time picker. Two variants: `"start"` (08:00–21:30) and `"end"` (08:30–22:00). Returns "HH:MM" 24-hour values.
- **AvailabilityPanel** is two-way bound with `LogSessionForm` via lifted `live` state. For multi-slot, the ghost overlay shows the FULL outer range — collision detection just works because conflict scope = the whole booked window.
- **SlotLengthToggle + SessionSlotsList** (`src/app/_components/`) are the multi-slot shared components. List reads `slots` from props (not a ref) so React Compiler's no-refs-during-render rule is satisfied. Per-slot note text is preserved only when the (startAt, endAt) signature is unchanged across renders — adjusting the range mid-typing loses notes.
- **Default `live.startTime` = now-rounded-down-to-half-hour, `live.endTime` = +1hr** on coach form load. With 30-min slot default that's automatically 2 slots → multi-slot mode triggers on first load. Acceptable UX (the 2-slot mode shows 2 notecards with empty notes; coach can just hit submit for a 1-hour booking by setting end to start+30min, or accept the 2-slot default).
- **Soft-delete (J9):** `users.deletedAt` non-null = anonymized. Active-coach surfaces filter `isNull(users.deletedAt)`; reports + audit log keep historical "Former coach" rows. `deleteCoachInternal` also clears Auth.js sessions + linked OAuth accounts + pending verification tokens.
- **Synthetic-coach merge:** `mergeSyntheticCoachInternal(actor, sourceId, targetId)` in `src/lib/server/user-actions.ts`. Re-points sessions, drops empty overrides, hard-deletes the synthetic. UI dropdown on `/admin/coaches` lists EVERY coach (real or synthetic) as a target — needed for the PFA Travel cleanup case (synthetic → synthetic merge). Source must be synthetic (`@imported.local`); enforced via `isSyntheticUserEmail()`.
- **Coach UI shows NO dollar amounts** anywhere. `/coach` landing tiles = Sessions + Hours. `/coach/sessions` rows show duration, no rate/total. V2 invoice surface noted in memory `project_coach_rate_visibility.md`.

## Pending Jacob-manual items

### Sales / branding push (separate chat — not in this session)
Dad + Mom's K8 walkthrough surfaced: the app feels utilitarian, not proprietary. They want the landing page to make coaches think "PFA invested in custom tech that no one else has." Jacob has a self-contained prompt drafted to kick off a dedicated branding/sales-exec chat (not in this main thread). The prompt covers landing page positioning, footer attribution for **Magna Software LLC** (Jacob's recommended LLC name — pending his confirmation), and 2–3 in-app craftsmanship details. Don't start that work in the main chat — it belongs in its own session per Jacob's call.

### LLC formation
Jacob asked for an LLC name. Recommended **Magna Software LLC** (leverages surname, accurate descriptor, future-proof for any software work). Alternatives: Magna Labs / Magna Code / Magnaworks. Jacob to verify availability in his state's Secretary of State registry before formally forming.

### K6 external scans (~10 min)
Code-side checks done; three live-site verifications still on Jacob:
1. https://securityheaders.com → expect A+. Headers verified via `curl -sIL` (HSTS preload, CSP, X-Frame-Options DENY, Permissions-Policy, Referrer-Policy).
2. https://observatory.mozilla.org → expect ≥ A. Commit `1af0d2a` added `object-src 'none'` + `frame-src 'none'`.
3. Signed-in prod console: `Sentry.captureException(new Error("K6 smoke"))` → confirm it lands in Sentry.

### K9 coach rollout
- Pick 2–3 friendly coaches first. David Lusk is the primary user behind the multi-slot feature — he's the obvious first invite.
- Send `docs/operations/coach-onboarding-email.md` template.
- After each signup, scan `/admin/coaches` for an "Imported" pill matching their name → click Merge to re-point their historical sessions to the real account.
- Wait ~3 days, fix anything, expand.

### K5 status page (post-launch nice-to-have)
Better Stack signup + GoDaddy CNAME at `status.pfacagerentals.com`. Not a launch blocker.

## What might come next (Jacob's recurring patterns)

- React to whatever Dad/Mom flag during their second week on the app.
- React to whatever David Lusk says after using multi-slot in anger.
- Sales/branding work (in its own chat — see above).
- Coach-onboarding email iteration after the first replies.

When in doubt about scope, **ask via AskUserQuestion before charging in** — recent sessions have all started with a pre-scope summary + design questions and that pattern works well.

## Acknowledge + start

Acknowledge with the "Cage Rentals tracking active" line + current session id, then ask Jacob what's next. The app is live with real data and real coaches arriving. Most work from here is reactive — feature requests from Dad/Mom + David, polish, V2 invoice surface eventually.

## Updating this file

Jacob will say "update HANDOFF.md" when context is filling and he wants the next fresh chat to pick up cleanly. When that happens:
1. Re-read this whole file first so you keep the format + voice.
2. Append newly-shipped work to the "Post-launch features shipped this session" block (newest first).
3. Refresh the commit list to the last ~9 commits.
4. Update any quirks / warns you discovered the hard way.
5. Move anything from "Pending" → "shipped" as appropriate.
6. Bump the date stamps where they appear inline.
7. Keep it under ~200 lines if possible — old shipped items can be summarized into one bullet rather than kept verbatim forever.
