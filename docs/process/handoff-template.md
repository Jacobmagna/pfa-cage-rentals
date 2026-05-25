# Handoff prompt template

Fill the `{{...}}` slots. Delete sections that don't apply. Keep it tight — the
fresh chat reads memory automatically, so don't restate things already in
`MEMORY.md`. The goal is enough context to execute, not a project history.

Tone: brief, declarative. The receiving Claude is competent. Don't over-explain.

---

## Template (copy below this line)

```
PFA Cage Rentals — {{short feature name}}

Tracking active hooks fire on session start; surface the "Tracking active" line per project memory.

## Pre-flight reads
{{Delete any that don't apply}}
- `MEMORY.md` (auto-loaded — gives stack, admins, design direction, workflow, product decisions)
- `docs/process/production-checklist.md` (state of the build)
- `docs/reference/design-spec.md` (UI work)
- `docs/reference/architecture.md` (backend / data-flow work)
- `docs/operations/runbook.md` (ops / incident work)
- `HANDOFF.md` (full prior-session context — only if this task threads from a recent landed change)

## Goal
{{One sentence — what we're shipping and for whom.}}

## Why
{{1-3 sentences — the user need or constraint driving this. Cite the person who asked if applicable (Dad, Mom, David Lusk, etc.).}}

## Scope — in
- {{Bullet the concrete changes. Be specific: file paths if known, schema changes, new routes, new components.}}
- {{...}}

## Scope — out
- {{What this task explicitly does NOT touch. Prevents scope creep in the fresh chat.}}
- {{...}}

## Constraints / quirks to respect
{{Only pull the load-bearing ones from HANDOFF.md "Important quirks" that apply to this task. Examples:}}
- TZ-aware everything — use helpers in `src/lib/timezone.ts`, never raw `new Date()` parsing.
- neon-http has no transactions; mutation-then-audit is sequential, use `safeLogAudit`.
- Public server actions in `"use server"` files are thin authz wrappers; internal logic lives in `src/lib/server/`.
- {{Add task-specific ones.}}

## Acceptance criteria
- [ ] {{Testable assertion 1 — e.g. "Coach sees X on /coach/sessions when Y."}}
- [ ] {{Testable assertion 2}}
- [ ] No regression in {{adjacent surface}} (sanity-check it after the change).
- [ ] `npm run lint` + `tsc --noEmit` clean.
- [ ] Browser-verified via preview tool {{if UI}}.

## Verification approach
{{Pick what applies:}}
- Browser preview: start dev server, exercise the new flow, screenshot or DOM-assert the changed surface.
- DB-state check: query `sessions_billing` / `users` / whatever to confirm writes.
- Unit/integration test: add to `src/**/*.test.ts` if billing.ts touched (100% coverage threshold).
- Manual SQL: `.env.local` DATABASE_URL is PROD — preview SELECT before any UPDATE/DELETE.

## Workflow
- Direct-to-main; no PR. Pre-commit hook runs lint-staged + tsc. CI runs full suite.
- **Pre-scope rundown before executing** — give a short bullet plan, ask for corrections via AskUserQuestion if any real design call comes up.
- Commit + push when green. Update `HANDOFF.md` if the change is non-trivial enough that the next coordination session needs to know.
- Report back to the coordination chat with: commit SHA, one-line summary, anything surprising encountered.

## Files likely involved
{{If known — saves the fresh chat a grep pass. Skip if exploratory.}}
- `src/...`
- `src/...`

## Open questions
{{If any design calls aren't resolved yet — list them so the fresh chat asks before charging in. Otherwise delete this section.}}
```
