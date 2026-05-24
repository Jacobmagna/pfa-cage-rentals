# PFA Baseball — Coach Scheduling & Billing Web App

Working notes for the web app replacing PFA Baseball's shared-Excel system for coach lesson scheduling and billing. Facility brand: **PFA Baseball**.

**Admins on launch:**
- Jacob (me) — `jacob@themagnas.com`
- Dad — `mdm@pfasports.com`
- Mom — `esther@pfasports.com`

**Product URL:** `pfacagerentals.com` — Dad will buy through Vercel during setup (~$12/year, one-click DNS). PFA Baseball has a separate Wix-hosted brand site Jacob doesn't have access to; this app is a standalone property at its own domain. Name framing matters: it's "cage rentals," not "scheduling" — consistent with the underlying Excel filename "Coaches Cage _ Bullpen Rentals.xlsx." The product is a **rental-billing tool first, scheduling second.**

**Auth (Google + email magic-link, decided 2026-05-23):** Original Workspace assumption was **wrong** — `mdm@pfasports.com` is not a Google account; sign-in fails with "couldn't find your Google Account." Pivoted to dual-provider:
- **Google OAuth** for coaches with Gmail (most of them).
- **Email magic-link via Resend** for Dad, Mom, and any non-Gmail coaches.
Sign-in page shows both options. Resend free tier (3k emails/mo) covers this app forever. Sender is `onboarding@resend.dev` until `pfacagerentals.com` is bought and verified with Resend (~5 min once DNS lands).

## The problem (in Dad's words, paraphrased)

Every private coach writes their lesson time into a shared Excel grid (one tab per week, rows = cages/bullpens/weight room, columns = 30-min time slots). Dad currently tallies everything by hand. He wants to pull reports like:

- "Show me everything D. Lusk did in May" — across all weeks, all cages.
- "Who used Cage 1 between June 1 and June 14, and how many hours each?"
- "Total hours per coach for an arbitrary date range."

The wall he keeps hitting: **coaches write their own names inconsistently.** Same coach appears as `D. Lusk`, `Lusk`, `David`, `David Lusk`, `Shannon`, `Shannon `, `Shannon v`, `Juan Garcia` vs `Juan Garcia1152`, etc. He doesn't want to force a dropdown / hardcoded list in Excel — he wants this to feel like a real tool, not a locked-down spreadsheet.

## What "good" looks like

A small app where Dad can:
1. Drop in (or point at) the weekly Excel file.
2. Pull a report by **coach**, **date range**, **resource (cage/bullpen)**, or any combo.
3. See total hours, list of individual sessions, and a breakdown by cage.
4. Trust that name variations are reconciled correctly, with the option to review/correct anything ambiguous.

## The data, structurally

- File: `source_data.xlsx`
- Tabs: one per week (`May 1-3`, `May 4-10`, ..., `Jun 29-30`), plus a template tab.
- Each tab is a 2D grid:
  - 5 days laid out horizontally, each day takes a block of ~6 columns
  - Rows = resources (Cage 1–5, Bullpen 1–2, Weight Room x3)
  - Cells = 30-minute time slots (8:00 AM through 10:00 PM)
  - Cell value = coach name (or empty)
- Date headers exist as real datetime cells (good — no need to parse "May 1 - May 3, 2025" string).
- Consecutive identical cells in a row = one continuous session (e.g., `D. Lusk` filling 11 cells in a row = one 5.5-hour block, probably back-to-back lessons).

## The name normalization problem

Real variations already in the file:

| Canonical (best guess) | Variants seen                                      |
| ---------------------- | -------------------------------------------------- |
| David Lusk             | `D. Lusk`                                          |
| Necoechea              | `Necoechea`, `Necoechea ` (trailing spaces)        |
| Shannon                | `Shannon`, `Shannon `, `Shannon v` (typo)          |
| Juan Garcia            | `Juan Garcia`, `Juan Garcia1152` (stray digits)    |
| Jose Iniguez           | `J.Iniguez`, `J.Iniguez (JP De La Cruz online)`    |
| J. Tyler               | `J. Tyler`, `Tyler (Member)` — maybe different?    |
| N. Milone              | `N. Milone`, `N. Milone (Academy Pablo)`, `(TEST)` |
| A. Milone              | `A. Milone (academy)`                              |
| M. Johnson             | `M.Johnson`, `M.Johnson `                          |

Important observation: **parentheses are usually context about the student/session**, not part of the coach name. Strip them off but keep them as metadata on the session.

## Approach options

### Option A — Local script + LLM-assisted alias map (recommended starting point)
1. Python parser reads each tab → emits clean rows: `(date, day_of_week, start_time, end_time, resource, raw_name, parenthetical_note)`.
2. Collapse consecutive same-name cells in a row into one session.
3. Build an **alias map**: `D. Lusk → David Lusk`. Start with simple fuzzy matching (lowercase, strip whitespace/punctuation, Levenshtein), then have an LLM pass on anything ambiguous, then Dad confirms once. Store as `aliases.json` so it's editable and persistent.
4. Reporting layer: a CLI (or tiny web UI) that filters by coach / date range / resource and outputs to Excel or a printable summary.

Pros: cheap, transparent, the alias map is editable forever. AI only does the hard part (name reconciliation).

### Option B — Full web app
Same engine, but with an upload form and a UI for Dad to browse reports, fix aliases, etc. More polish, more work.

### Option C — Replace the spreadsheet entirely
Build a tiny scheduling app coaches log into. Solves the root cause but is a way bigger lift, and Dad would have to onboard every coach.

**My recommendation:** start with **Option A**. The hard, valuable part is the parser + alias reconciliation. Once that's working, wrapping it in a UI is incremental. Option C is the "right" long-term answer but premature now.

## Answers from Dad (2026-05-23)

1. **Pricing:**
   - Cage: **$22 per 30-min slot**.
   - Bullpen: **$22 per 30-min slot** (same as cage).
   - Weight Room: **$10 per hour** = **$5 per 30-min slot**.
   - **Per-coach overrides:** some coaches have negotiated different rates. Dad must be able to set a custom rate for any coach without touching code. Config shape (proposed):
     ```json
     {
       "default_rates_per_30min": { "cage": 22, "bullpen": 22, "weight_room": 5 },
       "coach_overrides": {
         "David Lusk": { "cage": 18, "bullpen": 18 }
       }
     }
     ```
2. **No student names** — cells are coach-only. Parenthetical text = freeform notes; preserve as-is, don't try to parse.
3. **Excel reports** for v1. Web app possibly later.
4. **Internal only** — Dad + Mom (the accountants).
5. **~30 coaches**, with a long tail of one-off drop-ins. Name reconciliation matters more than first estimated — the rare coaches are most likely to be typo'd or typed only once.
6. **On demand.** No scheduling.
7. **Historical reconciliation included** — run the tool over all past tabs in the workbook, not just going forward. Doubles as a check on what Dad may have missed.
8. **It's both reports in one tool** — Dad wants full coverage: "who used what, when, and how much do they owe." Hours-only and billing-only are just different views of the same underlying session data.

## Updated problem framing

This is a **billing/rent reconciliation tool**, not a scheduling tool. The core output is "how much does each coach owe Dad for time period X." Hours are an intermediate value; dollars are the deliverable.

The monthly workflow Dad probably wants:
1. End of month, run the tool.
2. Get an Excel with one row per coach: name, total cage time, total weight room time, total $ owed, plus a detail tab listing every session.
3. Use that to invoice coaches (or reconcile what they've paid).

## Delivery model — FINAL (2026-05-23)

**Scope pivoted to a full web app — replacing the Excel entirely, not reading it.**

### Why this works (not premature anymore)
- Dad owns the facility. Coaches use the facility for *their* business. Adoption is not a real risk — they don't have somewhere else to go.
- Sign-up friction (Google one-click) is ≤ the current friction of "open old email, find Excel link, type name into the right time slot."
- Coaches logging in as themselves **completely eliminates the name-variation problem.** No more alias map, no more LLM normalization.
- It will feel more official, which is a small but real morale upgrade for the coaches.

### Stack & infra (decided)
- **Hosting:** Vercel free tier, under Dad's account. Jacob builds from his own machine; Dad's email is used for account / OAuth verification codes.
- **Database:** Free Postgres tier (likely Neon, which integrates cleanly with Vercel).
- **Auth:** Google sign-in. Coaches click "Sign in with Google," that's it. No passwords.
- **Cost target:** ~$0/month at this scale. Optional custom domain later (~$12/year).

### Product surfaces

**Coach (default role on sign-up):**
- "Log a session" form: date, start time, end time, resource (Cage 1–5, Bullpen 1–2, Weight Room), optional note.
- "My sessions" history: see/edit/delete recent sessions.
- Mobile-friendly — they'll do this on their phone right after a lesson.

**Admin (Dad + Mom):**
- **Schedule grid view** — the Excel-style grid Dad loves: resources down, time across, one column per day. Real-time, always current. Click any cell to add/edit. Drag to move sessions between coaches/times/cages.
- **Block-off mode** — paint over time ranges on a resource to mark it unavailable (closed, maintenance, reserved).
- **Reports** — pick coach + date range + resource, generate the same 3-sheet Excel (Summary / Detail / now no "Unmatched" tab since names are clean).
- **Coach management** — list of coaches, set per-coach rate overrides.
- **Historical import** — one-time: load the existing `source_data.xlsx` into the database so historical reports still work. Best-effort name normalization for the legacy rows only; new data is clean by construction.

### Data model (sketch)
- `users` — id, email, name, role (`coach` | `admin`), google_id, created_at
- `resources` — id, name, type (`cage` | `bullpen` | `weight_room`)
- `sessions` — id, coach_id, resource_id, start_at, end_at, note, created_at, created_by
- `rate_defaults` — type, rate_per_30min
- `coach_rate_overrides` — coach_id, resource_type, rate_per_30min
- `blocked_times` — resource_id, start_at, end_at, reason

### Suggested tech
- **Next.js 15 (App Router)** on Vercel — best fit, server actions remove most API boilerplate.
- **Drizzle ORM** + Neon Postgres.
- **Auth.js (NextAuth) v5** with Google provider.
- **Tailwind + shadcn/ui** for the UI.
- **ExcelJS** server-side for report generation.
- Schedule grid: start with a custom shadcn-based grid (we control it), revisit a library like `schedule-x` if it gets painful.

### Time tracking for billing (decided 2026-05-23)
Jacob is billing Dad hourly for this project. Hours must be captured automatically.

- **Mechanism:** Claude Code hooks — `UserPromptSubmit` and `Stop` events append JSON lines to `coaches-cage-ai/worklog/sessions.jsonl` with timestamp, session ID, event type, working directory.
- **Reports both metrics, Jacob picks at invoice time:**
  - **Total active session time** — first prompt to last response per session, with idle-gap exclusion (gaps > 15 min auto-excluded so a chat left open doesn't inflate hours).
  - **AI compute time** — turn-by-turn sum of (response_end − prompt_start). Pure "Claude thinking" time.
- **Claude Code time only.** No manual `worklog start/stop` CLI. Work done outside Claude Code (browser testing, debugging without me, reading docs) is NOT billed. Accepted undercounting.
- **Aggregator** — small Python script `worklog/report.py` produces an Excel/HTML report: per-session breakdown, per-day totals, project total in both metrics. Hourly rate is a config arg.
- **Must be set up BEFORE Phase 1 begins** so every minute of build time is captured. Otherwise we leak hours from the very work that sets up time tracking. Call this **Phase 0**.

### Build phases (within "full build")
0. **Time-tracking hooks** — register Claude Code `UserPromptSubmit` / `Stop` hooks scoped to this project directory, create `worklog/sessions.jsonl` and the `worklog/report.py` aggregator. Verify a few turns are captured correctly before moving on.
1. **Foundation** — Next.js scaffold, Vercel + Neon hooked up, Google auth, users table, admin/coach roles.
2. **Core data model + admin-only manual entry** — resources seeded, admin can create sessions for any coach. Proves the data layer.
3. **Coach session logging** — coach form + "my sessions" page.
4. **Reports** — Excel export with Summary / Detail tabs, filters.
5. **Schedule grid view (read-only)** — the Excel-style admin view.
6. **Schedule grid editing** — drag-to-move, click-to-add, click-to-edit.
7. **Block-off times** + coach management + rate overrides.
8. **Historical Excel import** — one-time backfill from `source_data.xlsx`.
9. **Polish + deploy + onboard coaches.**

### Open items (low urgency, can defer)
- Custom domain vs. `*.vercel.app` subdomain.
- Notification system (do coaches get an email when an admin moves their session?).
- Audit log (who created/edited/deleted what — useful for billing disputes).
- Bullpen rate confirmation — still assuming $22/30min per Dad.

## Implications for build

- **Rate config lives in a small file** (`rates.json` or top of the script) so Dad can update prices without touching code.
- **Bullpen rate needs confirmation** before billing reports go out. Flag it in the output until we know.
- **Alias map is now business-critical** — a typo'd name = a missed invoice = real money lost. Worth building a "review unmatched names" step into the workflow before any report is generated.
- **Output Excel layout** (proposed):
  - Sheet 1: `Summary` — one row per coach, columns: coach, # cage slots, cage $, # bullpen slots, bullpen $, # weight-room slots, weight-room $, **total $**, **rate flag** (default vs override applied).
  - Sheet 2: `Detail` — every session: date, day, start time, end time, duration, resource, coach (canonical), raw name, rate applied, $, freeform note (parenthetical).
  - Sheet 3: `Unmatched` — raw names the normalizer wasn't confident about, so Dad can update the alias map and re-run.
- **CLI filters** Dad can combine in any way:
  - `--coach "David Lusk"` (single or multiple)
  - `--from 2026-05-01 --to 2026-05-31` (any date range, including the full historical workbook by default)
  - `--resource cage` / `bullpen` / `weight_room`
  - Default with no filters = full workbook, all coaches, all resources.

## Data quirks worth noting

- The date cells in the file render as 2026 (e.g., `2026-05-01`), but the tab titles say "2025". Looks like the file was copy-pasted forward but the title text wasn't updated. We'll trust the cell dates and ignore the title text.
- One tab is named ` Template 250706` (leading space) — skip it during parsing.
- Some rows are completely blank (extra `Weight Room` rows that are unused) — fine, parser will just emit nothing for them.
