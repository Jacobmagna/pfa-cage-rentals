# PFA Operations Upgrade — Proposal for Mark & Esther

**From:** Jacob
**Date:** May 25, 2026
**Status:** Draft for discussion

---

## What this is

A proposal to extend the cage rentals website into a tool that handles the parts of PFA you currently do by hand — the tryouts roster, team formation, uniform orders, and family contact info. The goal is to cut down the hours you spend wrangling spreadsheets every season, without changing the parts of your job that work well today.

This isn't a replacement for anything you like. Constant Contact stays. Bridge stays. Sports Engine stays if you want to keep it (and goes away if you don't). The thing that changes is the backstage spreadsheet work neither of you should be doing in 2026.

---

## What you're doing today

I looked at the 2026 HS Summer Tryouts workbook to understand the current process. Here's what's in it:

- **212 athletes** in the master "Final" sheet
- **8 regional sheets** (LAN, IE, SFV, SGV, SB each split into "Registered" and "Not Registered")
- **3 versions** of the uniform order list, being iterated on by hand
- **4 versions** of the tournament schedule (Kevin's, Mark's, Final, Final Upload)
- **An "Issues" sheet** that's a hand-written log of data problems

A few specific things I noticed:

- Out of 212 athletes in the master sheet, **0** have a team assigned. Team assignments are happening only in the regional sheets and never make it back to the master.
- Out of 212 athletes in the master sheet, **0** have payment info filled in. Payment tracking is also happening only in the regional sheets.
- **58 athletes** don't have a tryout location filled in yet.
- **6 athletes** have "Please Provide" in the Grade column — missing required info.
- In the Lancaster sheet alone, **43 of 64 athletes** appear in BOTH the Sports Engine export AND Kevin's list (the same kid signed up twice, and Esther had to manually figure that out).
- **20 of those 64** are in NEITHER source — walk-ins or manual adds with no record of where they came from.

None of this is anyone's fault. It's what happens when you run a real operation in spreadsheets. The information is correct *somewhere*; it's just spread across nine sheets and Esther's memory.

---

## What we'd build (in plain English)

Four pieces. Each one is useful on its own, and each one builds on the one before it. We could ship all four or stop after any of them.

### 1. A real PFA contact book

Right now PFA's "list of who we are" is spread across 9 sheets in this workbook, plus Sports Engine, plus Kevin's lists, plus Constant Contact's audience, plus your memory. Every season you rebuild it from scratch.

We'd build **one place** where every athlete and family lives. Search and filter it like you'd filter an Excel column, but smarter — "show me every 2028 athlete in IE who hasn't paid yet" is one click instead of three sheets and a mental cross-check.

**What stays the same:**
- You still type the kid's info in (or you can paste it from another source).
- You still decide what tags or notes to attach.
- You decide who is a family, what teams they're on, what they've paid for.

**What changes:**
- Type the kid's info in **once**. After that, every team list, uniform list, payment list, and email list pulls from that one record.
- When two records look like the same kid (e.g., "Chase Billups" appeared in Sports Engine AND on Kevin's list), the system flags it and asks you to merge — instead of leaving it to Esther to spot.
- Required fields are required. No more "Please Provide" or trailing spaces in the Grade column.

### 2. A real signup form for tryouts

Today, parents register through Sports Engine, or Kevin adds them, or they show up at the door. Esther has to chase down which path each kid came through and reconcile three lists.

We'd build a **PFA-branded signup form** (lives at something like `tryouts.pfacagerentals.com`) that becomes the front door for new tryouts. Parent fills out everything you currently capture, pays the tryout fee by credit card on the same page, and lands directly in your contact book. They get an automatic confirmation email.

**What stays the same:**
- You can still accept walk-ins and manual additions — they just get marked as "manual entry" in the system instead of being invisible.
- Sports Engine can keep running in parallel if you want — we'd import the Sports Engine export with a click, and the system would auto-match duplicates.
- You can also turn Sports Engine off entirely once you trust this. That's your call, not the system's.

**What changes:**
- No more chasing payment. Stripe collects the tryout fee at signup; you see a list of who paid when.
- No more reconciling Sports Engine vs. Kevin's list — the form catches duplicates at the door.
- Real-time dashboard showing today's signups by location and grade year, so you can see momentum without refreshing anything.

### 3. A team formation tool

Today, after tryouts, you and Kevin/Mark figure out team assignments by hand. You look at the "Roster sizes" pivot table, decide how many teams per age group, then go back to each regional sheet and type the team name into each athlete's row. Then somebody updates the separate "PFA CA Kevin Rosters" sheet too (113 rows of duplicate data — same kids, second source).

We'd build a **drag-and-drop team builder**:
- Left side: unassigned athletes, filterable by grade and location.
- Right side: team cards (PFA CA Dirtbags 16u, PFA CA SoCal 15u, etc.). Each card shows the current roster, how many slots are left, and the position mix.
- Drag a kid onto a team. Done.

**What stays the same:**
- You and Kevin/Mark decide who goes on what team. The tool doesn't auto-assign.
- You can move kids between teams freely.

**What changes:**
- No more typing the team name into two different sheets and praying you got both.
- The tool shows you "this team has 8 infielders and 0 catchers" while you're building it, not after.
- "Who's unassigned?" is a button — currently it's invisible (35 Lancaster athletes are paid + registered + nowhere on a team right now, and there's no way to surface that without manually scanning).

### 4. A uniform order helper

Today, you (Esther) get a Shopify CSV of jersey orders, then hand-match each order against your team rosters to figure out who's ordered, who hasn't, and which team gets which bulk order. There are three versions of this list in the current workbook because you're iterating in real time.

We'd build a page where you **upload the Shopify CSV** and the system:
- Auto-matches each order to an athlete in your contact book (by name, email, phone).
- Surfaces three lists: matched orders (no action needed), orders we can't match (you decide), and athletes on rosters who haven't ordered (you chase).
- Shows jersey number conflicts before they hit the supplier ("two kids on Dirtbags 16u both want #27").
- Exports a clean bulk-order file grouped by team.

**What stays the same:**
- Shopify still takes the orders. We just read the export.
- You still place the bulk order with the supplier — we just give you a clean file to send.

**What changes:**
- Roughly 90% of the matching happens automatically. You validate the exceptions, not the whole list.
- Jersey number conflicts get caught before the order goes out.
- Number-history per athlete is preserved ("Carlos had #21 in 2025, asked for #27 in 2026").

---

## How the system handles your judgment calls

This part matters and it's why I'm calling it out explicitly. Right now, when a parent texts Mark saying "I got laid off, can my son still come?" — Mark makes a judgment call and adjusts the bill (or waives it). When an athlete needs to switch teams mid-season, you make a call. When a kid is splitting time between two locations, you flag it on the spreadsheet with a comment.

**The system has to support those judgment calls, not eliminate them.** That means:

- **Custom discounts / waived fees** — every payment has a "notes" field and a "marked as paid manually" toggle. If you waive a kid's tryout fee, you click "waived" and write the reason. The system records it; nobody has to know but you.
- **Multi-location athletes** — an athlete can belong to more than one location/team. No more "SFV/IE" hack in the Tryouts column.
- **Free-text notes per athlete** — every athlete record has a notes section for context Esther currently keeps in her head ("dad lost his job 2024; goes to PFA Travel and Dirtbags").
- **History of every change** — when a team gets reassigned, when a payment gets waived, when a record gets merged, it's logged with who did it and when. You can undo or see who changed what.

The goal is to make the routine work disappear so you have more energy for the judgment calls — not to replace the judgment calls.

---

## What I don't know yet

I've been reading the workbook from the outside. There's a lot I'd need to learn from a working session with both of you before building anything serious:

- The full lifecycle of a tryout signup, from form submission to roster placement, including the manual steps you do that aren't visible in the spreadsheet.
- How Sports Engine integrates today, what its CSV export actually looks like, and what its real pain points are (you've mentioned manually adding people to it — what triggers that?).
- The tournament fee + hotel + coach fee + food + gas tracking that's in the "Tourn Schedule FINAL Upload" sheet (29 columns) — is this a separate problem worth solving, or does it just need to be a tab next to the team page?
- How camp registration, throwing-program registration, and private lesson scheduling tie into the contact book — are these the same families or different lists today?
- What's in Constant Contact that you wouldn't want to give up, and what's in there that's just there because that's where you put it.

**I'd want to do a 1–2 hour working session with both of you before scoping anything formally.** Walk through a real day of the manual work with me watching. Half of what I'd build comes out of seeing the things that aren't in the spreadsheet because you do them in your head.

---

## Phases and timeline

Each phase delivers something useful on its own. You can stop after any phase. You can also skip phases — Phase 4 (uniform reconciler) doesn't strictly need Phase 1 (contact book) to be useful.

| Phase | What ships | Hours |
|---|---|---|
| **0. Discovery** | Working session at home + scoped plan with confirmed numbers | 3–5 |
| **1. Contact book** | Search/filter all athletes, families, tags. Sports Engine CSV import + duplicate merge. | 15–22 |
| **2. Tryouts signup form** | Public form, credit card payment, auto-confirmation, real-time dashboard. | 8–14 |
| **3. Team formation** | Drag-and-drop team builder, roster constraints, history of every change. | 8–14 |
| **4. Uniform helper** | CSV import, auto-match, conflict detection, bulk supplier export. | 8–14 |
| **Build subtotal** | | **42–69** |
| Buffer for discovery surprises + back-and-forth (25%) | | **+10–17** |
| **Total** | Full Tier 1 system | **52–86** |

Calendar: 5–8 weeks of build time at a sustainable pace of ~12–15 hours per week (evenings and weekends around my day job), plus 1–2 weeks of buffer for Mom/Dad review and iteration between phases. **Total calendar: 7–10 weeks** from kickoff.

Tighter timeline is possible if you've got a specific season deadline — just say so during discovery and I'll adjust pacing.

### How I sized this

These numbers come from real data, not guessing. The cage rentals build has been time-tracked automatically since May 23, so I have an exact record of how long things take me on this codebase.

In 15.5 hours of focused work over 3 days, I shipped roughly 22 commits including: privacy/terms pages, OAuth-to-production, soft-delete with full data anonymization, timezone-safe date handling everywhere, nightly automated database backups, full security headers pass, historical Excel import for 345 sessions, drag-to-move sessions, per-coach rate overrides, audit log viewer, multiple UI polish sweeps, the variable rates + online flag we just shipped, and the entire documentation set (README, runbook, architecture doc, onboarding email template).

The first invoice ($714 at $60/hr) covered 11.94 of those hours. The numbers above scale that velocity to the PFA work, but adjusted for the fact that **PFA Tier 1 reuses about 60% of the infrastructure already built into the cage rentals app.** Auth, admin shell, table+filter UI, merge-duplicates UI, CSV import flow, Excel export, audit log — all of these exist and just get re-pointed at the new athlete/family domain. The genuinely new work is the Stripe integration for tryout payments, the drag-and-drop team builder, and the public-facing tryouts form.

---

## Possible additions (not in this proposal, but worth flagging)

These are things I noticed in the workbook or in our prior conversations that could be useful but I deliberately kept OUT of the Tier 1 scope. Each one is its own follow-up project. I'm listing them so you can think about which ones you'd want next, AND so you can tell me if any of them should actually be IN Tier 1.

1. **Tournament fee + travel tracker.** The "Tourn Schedule FINAL Upload" sheet has 29 columns including hotel waiver, coach fee, food, gas, and balance-due tracking. This is a hidden second ledger that Mom is maintaining. A tournament page per team with this info parent-visible could kill a lot of inbound questions.

2. **Camp registration + payment.** PFA runs summer/winter/fall/spring camps. Today, signup probably happens through some combination of Constant Contact responses, walk-ins, and Mom's memory. A per-camp signup form (similar pattern to tryouts) with payment would standardize this.

3. **Travel team parent portal.** Read-only page per team where parents can see roster, upcoming tournament info, hotel info, payment status, uniform status. Doesn't replace Constant Contact for outbound emails — just answers the inbound "what time is the game / where's the hotel" questions before they get asked.

4. **Bulk email/text to filtered athlete groups.** Send a quick note to "everyone on PFA CA Dirtbags 16u" or "every 2028 athlete in IE" without copying parent emails into Constant Contact one by one. This is a supplement to Constant Contact, not a replacement — Constant Contact stays for branded newsletter-style sends; this is for ops messages like "rain delay, practice canceled."

5. **Coach payouts ledger.** Mark currently nets out cage rental fees against what he owes coaches (the "online lesson" math we just discussed). A simple admin page showing "you owe Coach X $Y this period" — built from the data already in the cage rentals app — could replace whatever Mark's currently using for that math.

6. **Lesson scheduling for students.** The cage rentals app today handles coach-side scheduling. Extending it to let students/parents book lessons directly (with their coach's pre-set availability) could replace whatever back-and-forth happens by text today.

7. **Sports Engine sunset.** If after Phase 1+2 you decide you want to drop Sports Engine entirely, this is a separate piece of work — migrating existing accounts, updating links, communicating to families. Not hard, but not in scope here.

8. **Document storage per athlete.** Medical forms, photo releases, birth certificates, school transcripts. Right now I assume these live in Mom's email and a filing cabinet. A per-athlete documents tab on their record could centralize this.

9. **Bulk operations.** "Select these 20 athletes and add them all to a camp" or "assign all of these to a team" or "send a payment reminder to everyone unpaid." Power-user tools that get useful once the contact book has real volume.

10. **Athlete/parent self-service portal.** Parent logs into a "My PFA" page, sees their kids, their kids' teams, their payment history, their upcoming tournaments, and can update their own contact info without bothering Esther.

None of these are in this proposal. They're listed so we have a roadmap to talk about during discovery. **If any of these change what's in Tier 1, tell me during the discovery session and we re-scope before any building starts.**

---

## Billing

Hourly billing at **$100 per hour**, tracked automatically per work session through the same system used on the cage rentals build. Invoices delivered at the end of each phase (or monthly, whichever is more convenient).

A note on the rate: this is higher than the $60/hr on cage rentals because that was a discounted introductory rate while I was getting the timekeeping system running and proving I could deliver on the cage rentals scope. $100/hr is the standard rate I'm setting as I move into client work outside of PFA. Still well below market for the kind of work I'm doing.

### Three ways to structure the engagement

**Option A — Phase by phase.** I scope Phase 0 (discovery, 3-5 hours), give you a tight hour estimate for Phase 1 before starting it, you approve, I build Phase 1, we evaluate before moving to Phase 2. Lowest commitment up front; you can stop at any phase boundary. Recommended.

**Option B — Whole project with a cap.** I commit to delivering all four phases at the estimated hour ranges above, billed hourly with a hard cap of 86 hours. If it comes in under, you pay less. If it threatens to go over, I stop and we have a conversation before continuing. Single contract, ongoing billing.

**Option C — Fixed bid.** I commit to delivering all four phases for a fixed total ($7,500 today, possibly adjusted up or down after the discovery session). Most predictable for you; some risk for me if scope creeps, so the number is at the high end of the hourly estimate range. Final fixed number quoted after Phase 0.

**I'd recommend Option A.** It lets you see real progress before committing to more, lets you stop if you don't see the value, and lets me adjust if discovery reveals something I'm missing.

### Cost breakdown by option at $100/hr

| Option | Low end | High end |
|---|---|---|
| A. Phase by phase | $5,200 | $8,600 |
| B. Capped hourly | $5,200 | $8,600 (capped) |
| C. Fixed bid | $7,500 | $7,500 |

For reference: that's roughly the cost of a single travel tournament weekend (entry fees + hotels) for one team. Over 7-10 weeks. Once.

---

## What I need from you to move forward

1. **A 1-2 hour discovery session at home in the office, all three of us together.** I'll watch how you work, ask questions, take notes. No commitment to build anything yet.
2. **Read access to the live Sports Engine account** so I can see the real export format and the manual pain points firsthand, not just the cleaned-up version in the spreadsheet.
3. **The latest copy of the master roster spreadsheet** (the one I already have is from May 25).
4. **Decision on billing structure** — Option A, B, or C above.
5. **A rough sense of which "Possible Additions" matter to you** — not commitments, just signal so I know what to look for during discovery.

After discovery I'd come back with a tight Phase 1 plan, a confirmed estimate, and a start date.

---

## A note on what this is and isn't

This proposal is about the **operations side** of PFA — the spreadsheet work, the rosters, the orders, the signups. It is NOT:

- A marketing website. That's a separate conversation if/when you want it.
- A training-program app like Driveline's. PFA's value is the relationships and the experience, not a cookie-cutter program. Bridge already covers the program side.
- A replacement for Constant Contact. Esther's email work is good and it stays.
- A replacement for your judgment. The exceptions you make for families in tough spots are part of why PFA is what it is. The system is designed to support those, not standardize them away.

The goal is to give you back the hours currently lost to manual spreadsheet wrangling, so you can spend that time on the things only you can do.

Let me know your thoughts. Happy to walk through any of this in person.

— Jacob
