// stipend SPEC §6 / §15 Phase B3 — the ADMIN WRITE PATH for stipend amounts.
//
// Outside any "use server" file, deliberately: Next.js exposes every async
// export from a "use server" file as a public RPC endpoint, and these
// functions take the actor as a parameter — exposing them directly would let
// anyone forge an admin identity and put themselves on a $10,000 stipend. The
// public wrapper gates with `requireRole("admin")`.
//
// 🔴 `requireRole("admin")`, NEVER `requireScheduleAccess()`. A schedule admin
// (Nick, today) can reach the Master schedule and nothing else — money, pay,
// reports, roster and audit are all plain-admin. A stipend is pay. Wiring this
// to the schedule guard would hand the one coach on a stipend the ability to
// set his own.
//
// ── What is enforced WHERE, and why the split ──────────────────────────────
//   · SHAPE            → `schemas/stipend.ts` (zod, importable by the form)
//   · TEMPORAL RULES   → `lib/stipend/engine.ts` (pure, mutation-tested)
//   · I/O + AUDIT      → here
// The planner owns every rule that decides whether money moves, so those rules
// are provable with literals. This module does no deciding it can avoid.
//
// ── There is no interactive transaction, and the shape is the answer ───────
// 🔴 SPEC §6.3 says non-overlap is "checked in the action inside a
// transaction." It cannot be: the driver is `neon-http`, which is stateless
// and has no `db.transaction()` (see the note at `rate-reprice.ts:46`). The
// atomic unit here is `db.batch()`, which is one Neon transaction but cannot
// read-then-decide inside itself.
//
// So overlap is prevented STRUCTURALLY instead of by a locked read. The
// history is append-only and forward-only: a new version must start strictly
// after every version on file, and the same batch that inserts it closes the
// previously-open row at exactly that instant. Two windows that meet at a
// shared boundary cannot overlap. The check-then-write gap remains — a second
// admin saving in the same few milliseconds would have their check pass
// against stale rows — but the failure mode is bounded: the LATER insert
// still starts after the earlier one on file only if it genuinely does, and
// the worst case is a close-at that lands on the wrong row, which the
// `effective_from` ordering makes visible in the history card rather than
// silent in the money. Exposure is a single-admin facility, and this is the
// same accepted-window reasoning `rate-effective-dating-actions.ts` documents
// for its guard.
//
// ── Nothing here touches `coach_stipend_earnings` ─────────────────────────
// Changing an amount NEVER rewrites an earning (Mark's Q5). Earnings carry
// their own `amount_cents` snapshot, written when an hour log posts, and
// nothing automatic ever removes one (Q3). This module writes `coach_stipends`
// and the audit trail, and that is all it writes.

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { coachStipends, users } from "@/db/schema";
import type { AuthedSession } from "@/lib/authz";
import { CoachNotFoundError } from "@/lib/errors";
import {
  endCoachStipendSchema,
  setCoachStipendSchema,
} from "@/lib/schemas/stipend";
import {
  planEndStipend,
  planSetStipend,
  type StipendVersion,
} from "@/lib/stipend/engine";
import { safeLogAudit } from "./audit-helpers";

/** The audit `entityType` for every stipend write. Grep-able, one spelling. */
export const STIPEND_ENTITY_TYPE = "coach_stipend" as const;

/**
 * Every stipend version for one coach, oldest first.
 *
 * Exported because the Phase C history card and the planner's callers read the
 * same list, and two queries that must agree about "this coach's versions" is
 * exactly the *"same function is not the same inputs"* trap the 2026-08-13
 * sweep named.
 */
export async function fetchCoachStipendVersions(
  coachId: string,
): Promise<StipendVersion[]> {
  return db
    .select({
      id: coachStipends.id,
      amountCents: coachStipends.amountCents,
      effectiveFrom: coachStipends.effectiveFrom,
      effectiveTo: coachStipends.effectiveTo,
    })
    .from(coachStipends)
    .where(eq(coachStipends.coachId, coachId))
    .orderBy(asc(coachStipends.effectiveFrom));
}

/**
 * The stipend amount in effect for `coachId` at `at`, or null.
 *
 * ⚠️ NOT the resolver the hour-log path uses — that one is
 * `fetchStipendAmountCentsForPeriod` in `hour-log-actions.ts`, and it resolves
 * against the PERIOD's start rather than an arbitrary instant. This one exists
 * for the admin card ("currently: $2,500 / half-month") and must never be
 * substituted for it: resolving pay against "now" instead of the period start
 * is how a mid-period amount change would rewrite a period Mark already
 * closed.
 */
export async function fetchCurrentCoachStipend(coachId: string) {
  const [row] = await db
    .select()
    .from(coachStipends)
    .where(
      and(eq(coachStipends.coachId, coachId), isNull(coachStipends.effectiveTo)),
    )
    .orderBy(asc(coachStipends.effectiveFrom))
    .limit(1);
  return row ?? null;
}

/**
 * Put a coach on a stipend, or change their amount from a future pay period.
 *
 * @param now injected so the §12.4 back-pay guard is testable with literals.
 *   The public wrapper passes `new Date()`.
 * @throws StipendPlanError (period boundary, forward-only, backdate) ·
 *   CoachNotFoundError
 */
export async function setCoachStipendInternal(
  actor: AuthedSession["user"],
  input: unknown,
  now: Date = new Date(),
) {
  const parsed = setCoachStipendSchema.parse(input);

  await assertCoachExists(parsed.coachId);

  const existing = await fetchCoachStipendVersions(parsed.coachId);

  // 🔴 Every refusal happens HERE, before a single row is written. A
  // StipendPlanError leaves the database untouched — there is no partial
  // state to unwind, which is what makes the missing transaction survivable.
  const plan = planSetStipend({
    existing,
    amountCents: parsed.amountCents,
    effectiveFrom: parsed.effectiveFrom,
    now,
    confirmBackdate: parsed.confirmBackdate,
  });

  const closedRow = plan.closeRowId
    ? (existing.find((v) => v.id === plan.closeRowId) ?? null)
    : null;

  const inserted = {
    coachId: parsed.coachId,
    amountCents: plan.amountCents,
    effectiveFrom: plan.effectiveFrom,
    effectiveTo: null,
    note: parsed.note ?? null,
    createdBy: actor.id,
  };

  // ONE batch = ONE Neon transaction. The close and the insert land together
  // or not at all — a close without its replacement would leave the coach
  // silently off a stipend, and an insert without its close is the overlap
  // this whole module exists to prevent.
  const statements = [
    ...(plan.closeRowId && plan.closeAt
      ? [
          db
            .update(coachStipends)
            .set({ effectiveTo: plan.closeAt })
            .where(eq(coachStipends.id, plan.closeRowId)),
        ]
      : []),
    db.insert(coachStipends).values(inserted).returning(),
  ] as const;

  type BatchStatements = Parameters<typeof db.batch>[0];
  const results = await db.batch(statements as unknown as BatchStatements);
  const returned = results[results.length - 1] as Array<
    typeof coachStipends.$inferSelect
  >;
  const row = returned[0];

  // The audit is a SEPARATE, swallowable statement (safeLogAudit), matching
  // every other internal mutation in this codebase. The batch above is what
  // must be atomic; a logging hiccup must not report the save as failed.
  //
  // `diffMode: "full"` — this is a hand-built report of a two-row change, not
  // one row's before/after, so a shallow diff would describe it wrongly.
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: STIPEND_ENTITY_TYPE,
    entityId: parsed.coachId,
    action: closedRow ? "update" : "create",
    diffMode: "full",
    before: closedRow
      ? ({
          amountCents: closedRow.amountCents,
          effectiveFrom: closedRow.effectiveFrom,
          effectiveTo: closedRow.effectiveTo,
        } as unknown as Record<string, unknown>)
      : undefined,
    after: {
      amountCents: row.amountCents,
      effectiveFrom: row.effectiveFrom,
      closedVersionId: plan.closeRowId,
      // 🔴 Recorded because it is the ONLY durable evidence that an admin was
      // shown the back-pay warning and accepted it. §12.4's whole risk is
      // money the app newly claims is owed that may already be settled in
      // cash; "who approved that, and what were they told it cost" has to
      // survive in the audit trail.
      backdatedPeriodKeys: plan.backdatedPeriods.map((p) => p.key),
      note: row.note,
    } as unknown as Record<string, unknown>,
  });

  return { row, closedVersionId: plan.closeRowId, plan };
}

/**
 * Take a coach OFF a stipend from `effectiveTo` forward.
 *
 * Earnings already written stand — this only stops future periods from
 * resolving an amount. Logs already posted keep their `stipend_covered`
 * snapshot and their $0, which is correct: the stipend that paid for them was
 * in effect when they were logged.
 *
 * @throws StipendPlanError · CoachNotFoundError
 */
export async function endCoachStipendInternal(
  actor: AuthedSession["user"],
  input: unknown,
  now: Date = new Date(),
) {
  const parsed = endCoachStipendSchema.parse(input);

  await assertCoachExists(parsed.coachId);

  const existing = await fetchCoachStipendVersions(parsed.coachId);
  const plan = planEndStipend({
    existing,
    effectiveTo: parsed.effectiveTo,
    now,
    confirmBackdate: parsed.confirmBackdate,
  });

  const before = existing.find((v) => v.id === plan.closeRowId) ?? null;

  const [row] = await db
    .update(coachStipends)
    .set({ effectiveTo: plan.closeAt })
    .where(eq(coachStipends.id, plan.closeRowId))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: STIPEND_ENTITY_TYPE,
    entityId: parsed.coachId,
    action: "update",
    diffMode: "full",
    before: before as unknown as Record<string, unknown>,
    after: {
      id: row.id,
      amountCents: row.amountCents,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      endedBackdatedPeriodKeys: plan.backdatedPeriods.map((p) => p.key),
    } as unknown as Record<string, unknown>,
  });

  return { row, plan };
}

/* ── internals ───────────────────────────────────────────────────────────── */

/**
 * A stipend row's `coach_id` FK would reject a bad id anyway, but as a raw
 * Postgres error with no useful message. Checking first turns "23503 foreign
 * key violation" into the error the rest of this codebase already throws for
 * an unknown coach.
 */
async function assertCoachExists(coachId: string): Promise<void> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, coachId))
    .limit(1);
  if (!row) throw new CoachNotFoundError(coachId);
}

/** Re-exported so a caller needs one import for the write path and its errors. */
export { StipendPlanError } from "@/lib/stipend/engine";
