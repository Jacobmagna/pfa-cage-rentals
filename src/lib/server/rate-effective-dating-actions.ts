// SPEC rate-effective-dating Phase C — the SERVER-ACTION layer that joins
// "set a rate" (which already existed) to "re-price what was already logged"
// (the Phase-B engine in ./rate-reprice.ts).
//
// Outside any "use server" file, deliberately: Next.js exposes every async
// export from a "use server" file as a public RPC endpoint, and these
// functions take the actor as a parameter — exposing them directly would let
// anyone forge an admin identity and rewrite payroll. The public wrappers
// gate with requireRole("admin") (SPEC decision §10.2 — plain admin, no new
// permission concept) and live in:
//   • src/app/admin/coaches/[id]/actions.ts   — the per-coach override card
//   • src/app/admin/hour-log/programs/actions.ts — the program Work tab
//
// ── ORDER IS NOT NEGOTIABLE: UPSERT THE RATE, THEN RE-PRICE ──────────────
// The engine does not accept a rate. It RE-RESOLVES each log by reading the
// override / program rows out of the database through the same resolvers that
// price a fresh log (SPEC §2). So the new rate must already be persisted when
// applyRateReprice runs, or the retro would re-stamp every log with the OLD
// rate — a silent no-op at best and a wrong number at worst.
//
// ── THE NULL PATH IS THE OLD PATH ───────────────────────────────────────
// When no effective date is supplied, these functions do exactly one thing:
// call the pre-existing *Internal upsert and return. No preview query, no
// engine call, no extra write. That is what makes "going forward only"
// byte-identical to the behavior that shipped before effective dating.
//
// ── THE DECREASE GUARD IS HERE, NOT IN THE UI ───────────────────────────
// SPEC §6: the app has no payout ledger — Mark pays coaches outside the
// system — so a retro DECREASE can "un-pay" money already handed over. The
// Phase-D dialog will warn, but the warning is not the control. This layer
// recomputes the diff SERVER-SIDE (a caller-supplied preview is never read,
// never trusted) and throws RateRepriceDecreaseNotConfirmedError before a
// single hour_logs row is written unless the caller passed
// `confirmDecrease: true`.
//
// ── What "refused" does and does not roll back ──────────────────────────
// A refusal writes NOTHING to hour_logs and NOTHING to audit_log's re-price
// trail. The rate row itself was already upserted by then, and that is
// intended: setting the rate going forward is the part of the request that is
// never in question, and it is also the precondition the engine reads. So a
// refused decrease leaves the system in the same state as "admin saved the
// rate going forward" — the safe half — and Phase D re-submits the identical
// payload with `confirmDecrease: true` to complete it (that re-submit's
// upsert is then a no-op, and the engine is idempotent).

import { z } from "zod";
import type { AuthedSession } from "@/lib/authz";
import { RateRepriceDecreaseNotConfirmedError } from "@/lib/errors";
import { updateProgramSchema } from "@/lib/schemas/program";
import { upsertProgramRateOverrideSchema } from "@/lib/schemas/rate-override";
import { updateProgramInternal } from "./program-actions";
import { upsertProgramRateOverrideInternal } from "./program-rate-override-actions";
import {
  applyRateReprice,
  previewRateReprice,
  type RateRepricePreview,
  type RateRepriceResult,
  type RateRepriceScope,
} from "./rate-reprice";

// ─────────────────────────────────────────────────────────────────────────
// Input + output contracts
// ─────────────────────────────────────────────────────────────────────────

/**
 * The retro confirmation flag, parsed OFF the same payload as the rate.
 *
 * It lives in its own schema rather than on the rate schemas because it is a
 * command flag, not rate data: it must never be persisted, and the rate
 * schemas strip it for exactly that reason. Unknown keys are stripped rather
 * than rejected (zod object default), so this is safe to run over a payload
 * that is mostly rate fields.
 */
const repriceConfirmSchema = z.object({
  confirmDecrease: z.boolean().optional(),
});

/**
 * What the re-price half of a save did.
 *
 *  - `not_requested` — no effective date. Nothing was re-priced and nothing
 *    was even queried; the save behaved exactly as it did before Phase A.
 *  - `applied` — the engine ran. Carries the preview it ACTUALLY applied
 *    (re-loaded and re-computed inside applyRateReprice, not the one the
 *    guard looked at), so the UI reports the number that really moved.
 */
export type RateRepriceOutcome =
  | { status: "not_requested" }
  | ({ status: "applied" } & RateRepriceResult);

const NOT_REQUESTED: RateRepriceOutcome = { status: "not_requested" };

// ─────────────────────────────────────────────────────────────────────────
// The shared retro half
// ─────────────────────────────────────────────────────────────────────────

/**
 * Guard, then apply. Called ONLY after the new rate is persisted.
 *
 * The guard runs `previewRateReprice` — three SELECTs and a pure function, no
 * writes — and refuses on any decrease without explicit confirmation. Then
 * `applyRateReprice` re-loads and re-computes from scratch and writes its
 * UPDATEs and audit inserts in one `db.batch` (one Neon transaction).
 *
 * DELIBERATELY NO `candidateRate` on the guard's preview, even though the
 * preview path accepts one (SPEC §7 / Phase D1). The candidate exists so the
 * DIALOG can quote a rate before it is saved; by the time this runs the rate
 * is already persisted (step 1 above), so the only correct question here is
 * "what does the SAVED rate do". Feeding the guard a caller-supplied rate
 * would let a client shape the decrease check it is meant to be checked by.
 *
 * KNOWN, ACCEPTED WINDOW: the guard's read and the apply's read are two
 * round trips, so a concurrent write between them could in principle turn a
 * cleared diff into a decreasing one. Closing it would mean handing the
 * engine a pre-computed diff to apply — exactly the caller-supplied-preview
 * hole SPEC §6 forbids — so the two independent recomputations stay. The
 * exposure is a few milliseconds against a single-admin facility, and the
 * audit row carries every old per-log rate either way.
 */
async function guardThenApply(
  actor: AuthedSession["user"],
  scope: RateRepriceScope,
  effectiveFrom: Date,
  confirmDecrease: boolean,
): Promise<RateRepriceOutcome> {
  // 🔴 SPEC §6. Recomputed HERE, server-side. Nothing the caller sent about
  // what the diff "is" reaches this decision.
  const preview: RateRepricePreview = await previewRateReprice({
    scope,
    effectiveFrom,
  });
  if (preview.decreases.logCount > 0 && !confirmDecrease) {
    throw new RateRepriceDecreaseNotConfirmedError(preview);
  }

  const result = await applyRateReprice(actor, { scope, effectiveFrom });
  return { status: "applied", ...result };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-(coach, program) OVERRIDE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Save a per-coach program rate override, optionally re-pricing that coach's
 * already-logged hours on that program back to `effectiveFrom`.
 *
 * Scope is the single (coach, program) pair. No other coach is read or
 * written, whatever date is picked.
 */
export async function upsertProgramRateOverrideWithRepriceInternal(
  actor: AuthedSession["user"],
  input: unknown,
): Promise<{
  override: Awaited<ReturnType<typeof upsertProgramRateOverrideInternal>>;
  reprice: RateRepriceOutcome;
}> {
  // Parse before writing anything: a future effective date (SPEC §10.1), a
  // per-session mode with no amount, a bad coachId — all rejected here, with
  // the rate row untouched.
  const parsed = upsertProgramRateOverrideSchema.parse(input);
  const { confirmDecrease } = repriceConfirmSchema.parse(input);

  // 1. THE RATE FIRST. The engine re-resolves from this row.
  const override = await upsertProgramRateOverrideInternal(actor, input);

  // 2. No effective date → going forward only. Identical to the old action.
  if (parsed.effectiveFrom == null) {
    return { override, reprice: NOT_REQUESTED };
  }

  // 3. Guard, then re-price.
  const reprice = await guardThenApply(
    actor,
    {
      kind: "override",
      coachId: parsed.coachId,
      programId: parsed.programId,
    },
    parsed.effectiveFrom,
    confirmDecrease === true,
  );
  return { override, reprice };
}

// ─────────────────────────────────────────────────────────────────────────
// PROGRAM DEFAULT
// ─────────────────────────────────────────────────────────────────────────

/**
 * Save a program (including its default rate), optionally re-pricing the
 * already-logged hours on that program back to `defaultRateEffectiveFrom`.
 *
 * SPEC §5 survives this layer for free: the retro's scope is the program, and
 * a coach who holds their own override on it re-resolves at step 1 of the
 * precedence chain, so the program default supplies nothing for their logs and
 * they come back unchanged. There is no coach predicate anywhere in this path
 * — not here, not in the engine, not in its SQL. Those coaches are reported by
 * name on `preview.excludedCoaches` so Phase D can show Mark the rule working.
 */
export async function updateProgramWithRepriceInternal(
  actor: AuthedSession["user"],
  programId: string,
  input: unknown,
): Promise<{
  program: Awaited<ReturnType<typeof updateProgramInternal>>;
  reprice: RateRepriceOutcome;
}> {
  const parsed = updateProgramSchema.parse(input);
  const { confirmDecrease } = repriceConfirmSchema.parse(input);

  // 1. THE RATE FIRST.
  const program = await updateProgramInternal(actor, programId, input);

  // 2. Absent OR explicitly null → going forward only.
  if (parsed.defaultRateEffectiveFrom == null) {
    return { program, reprice: NOT_REQUESTED };
  }

  // 3. Guard, then re-price. `program.id` rather than the parameter: the
  //    update already proved the row exists (else ProgramNotFoundError).
  const reprice = await guardThenApply(
    actor,
    { kind: "program_default", programId: program.id },
    parsed.defaultRateEffectiveFrom,
    confirmDecrease === true,
  );
  return { program, reprice };
}
