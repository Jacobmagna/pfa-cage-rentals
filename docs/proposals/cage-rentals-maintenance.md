# Cage Rentals — Scope, Maintenance, and What Comes Next

**A companion to the value-anchor doc and the PFA Tier 1 proposal.** This one is about cage rentals specifically — what the $700 actually covered, what's been added since, how ongoing changes get billed going forward, and where the line is between this and Tier 1.

---

## What the $700 covered

The $700 was a **fixed-price contract for the cage rentals app as it existed on Monday, May 25, 2026 at 9:30 AM PDT** — the moment the invoice was handed over. That snapshot included:

- The full coach + admin web app live at pfacagerentals.com
- Sign-in (Google OAuth + email magic-link), three admin accounts, coach role-based access
- Schedule grid with drag-to-move + click-to-edit
- Block-off times
- Session create / edit / delete for coaches and admins
- Reports + Excel export with filters
- Per-coach rate overrides
- Historical Excel import of all 345 prior sessions
- Privacy + Terms pages, full security headers, nightly database backups
- Coach onboarding email template + admin runbook documentation

**That delivery is locked.** The $700 invoice is closed. The "Cage Rentals Base" tab in the worklog is frozen — no new hours get added to it, and no money flows in or out of it again. It was a fixed-price job and it's done.

---

## What's been added since (and what's coming)

Once the app went live and Dad + Mom walked through it, real-world feedback started arriving. Some of it has already shipped; the rest will come in over the next weeks and months as you actually use the system. This is the natural rhythm of any production software product — there is always something to tune, fix, or extend.

**Already shipped since May 25 (a partial list):**

- Variable per-coach rates with full historical backfill — Fry, Iniguez, Gomez, Parker, Sanchez, Leon, David Lusk, Gonzalez each at their negotiated rate; all 345 historical sessions corrected
- "Prepaid online lesson" flag that forces a session to $0 (PFA collects from the client directly)
- Multi-slot batch session creation — David Lusk specifically needs to book 4+ hours of back-to-back 30-min lessons in one form submission
- Team-rental flag with gold "Team" pill rendering across every display surface
- Filter system on `/admin/sessions` with multi-select coach, resource, use-type, and date-range filtering
- Synthetic-coach merge — when a real coach signs up to claim their imported sessions
- "Back" links and several UI polish fixes raised during the K8 walkthrough
- Coach UI removed all dollar amounts — rates are variable and surfacing them to coaches creates expectation-mismatch issues
- Allow synthetic-target merges during the historical-import cleanup

This is **15 sessions of work over the last day and change.** All of it is tracked automatically via the same worklog system that captured the base build. None of it was in the $700.

**Coming in the next few weeks (likely):**

- More requests from Dad + Mom as they actually run a month of operations on the new system
- Whatever David Lusk asks for after he's been using multi-slot batch in anger
- Coach-facing tweaks as the rest of the coaches sign up and bring their own quirks
- A V2 invoice surface for coaches (currently they see Sessions + Hours but no dollar amounts; eventually they'll need an Invoices tab)

---

## How ongoing changes get billed going forward

Every change request after May 25 09:30 gets tracked in the **Cage Rentals — Iteration** tab of the worklog and billed at **$150 per hour**.

A few things to know about the structure:

**1. The rate is lower than Tier 1.** Tier 1 (new product work — contact book, tryouts form, team formation, uniform helper) is $200/hr because it's a new build with a defined scope and timeline. Iteration work on cage rentals is $150/hr — a 25% maintenance discount that reflects the fact that the architecture, codebase, and patterns are already in place. The cognitive load is lower, the work is more predictable, and the relationship is ongoing.

**2. Everything is tracked automatically.** The worklog system that captured the base build is still running. Every minute of work on cage rentals from May 25 09:30 onward shows up in the Iteration tab. You can see every session, every date, every hour, at any time. Nothing is invisible.

**3. The worklog is open to you.** Either of you can open `worklog_report.xlsx` and see exactly what's been worked on, when, and what the running total is. No black box, no trust required. If a number ever looks wrong, the data is right there.

**4. There is no minimum and no commitment.** I'm not asking PFA to commit to a number of hours per month. You don't owe me iteration hours. If there's nothing to fix or add, no hours get billed. If something breaks at 11 PM during tryouts, I fix it that night and bill the time — at the same $150/hr rate, no rush premium, no after-hours upcharge.

**5. Billing cadence is monthly.** I'll send an invoice covering the prior month's Iteration hours on the 1st of each month. First invoice will cover all post-May-25 work to date.

---

## How to request changes

Whatever's easiest for you:

- **Quick stuff** (small bug, copy change, color tweak): text or call. I'll either fix it that day or queue it for the next batch.
- **Bigger asks** (new feature, a new admin tool, a workflow change): send me a short note describing the problem you're trying to solve. I'll give you a rough hours estimate before I start. If it's more than a couple hours of work, you'll see the estimate before I commit any time.
- **Anything urgent / production-down** (the site is broken, coaches can't log in, reports are wrong): call immediately. I'll prioritize over everything else.

The only thing I'd ask is that for any single ask that would take more than ~3 hours of work, I confirm the estimate with you before starting. Below that threshold, I'll just do it and bill it — checking in on every 30-minute task would slow both of us down.

---

## Where this stops and Tier 1 begins

These are **two different commercial relationships** even though they involve the same software and the same people:

| | Cage Rentals — Iteration | PFA Tier 1 |
|---|---|---|
| **What** | Ongoing maintenance + small features on the cage rentals app | A new system: athletes contact book, tryouts form, team formation, uniform helper |
| **Rate** | $150 / hr | $200 / hr |
| **Scope** | Open-ended, request-driven | Defined in the Tier 1 proposal, phase-by-phase |
| **Timeline** | No timeline, runs indefinitely | 7–10 weeks of build, then closes |
| **Cancel anytime?** | Yes, just stop sending requests | Yes, between phases |
| **Cost ceiling** | None — you only pay for hours requested | Estimated $10,400–$17,200 total at the high end |

If a Tier 1 feature ends up wanting some change to cage rentals to make the integration work, that change gets billed as Iteration ($150/hr) — not folded into Tier 1. Each piece of work is categorized by *what it is*, not by *which conversation it came up in*.

---

## Why I'm spelling this out

Two reasons.

**One.** Without a clear framework, every iteration ask from you starts to feel either "free" (because it's small and the cage rentals app is "done") or "uncomfortable" (because there's no clean way to discuss billing for it). Both of those are bad for the relationship. With this framework, there's no ambiguity — you ask, I track, you see the hours, you get a monthly invoice, and we both know the rate going in. The conversation becomes clean.

**Two.** If we don't separate maintenance from Tier 1 explicitly, the two get conflated and the numbers get muddy. PFA deserves to know exactly what each piece of work costs. I deserve to be paid for each piece of work cleanly. Both get easier when the lines are clear.

---

## What I need from you to start this cleanly

Nothing big — just a quick verbal confirmation that the framework works for you:

1. **Cage rentals base is locked at $700, done.** ✅ (already true)
2. **Iteration work from May 25 onward gets billed at $150/hr, invoiced monthly.** I need a yes on this.
3. **Tier 1 is its own conversation with its own pricing structure.** Covered in the separate Tier 1 proposal.

That's it. A yes-or-modify on point #2 is the only decision in this document.

— Jacob
