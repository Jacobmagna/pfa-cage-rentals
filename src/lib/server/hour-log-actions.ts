// Internal hour-log mutation logic. Lives outside any "use server"
// file because Next.js exposes every async export from "use server"
// files as a public RPC endpoint — and this function takes the actor
// as a parameter, so exposing it would let anyone forge an admin
// identity.
//
// TWO public wrappers reach the create path, and they gate differently:
//   • src/app/coach/hour-log/actions.ts  → requireSession()      → logHourInternal
//   • src/app/admin/hour-log/actions.ts  → requireRole("admin")  → logHourForCoachInternal
//
// 🔴 ONE WRITER, TWO ENTRY POINTS. Both wrappers run the SAME
// `writeHourLogInternal`, parameterised by a `HourLogAuthor` that separates
// WHO is writing from WHOSE hours are being written. That separation is the
// safety property: pricing, the duplicate rule and the stipend trigger all
// live in one body, so identical work cannot price differently depending on
// who typed it, an admin entry cannot acquire a second duplicate rule, and the
// stipend earns without anyone having to remember to make it.
//
// Pipeline (mirrors createSessionInternal):
//   1. Zod-parse                        — createHourLogSchema
//   2. Program lookup + active check    — business invariant. Any coach
//      may log against any active program (DEC-29), so there's no
//      per-coach program-access gate here. The active check is coach-side
//      only; an admin recording historical hours may name a retired program.
//   3. Insert, then audit (sequential)  — see "Atomicity" below
//
// Atomicity: neon-http is stateless HTTP and does NOT support
// transactions. We insert first, then log the audit row as a
// separate statement (via safeLogAudit, which swallows + Sentry-
// captures audit failures so a logging hiccup never loses a logged
// hour). Same shape as the session create path.

import { and, desc, eq, gt, gte, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db";
import {
  coachPayments,
  coachStipends,
  hourLogs,
  programRateOverrides,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import { workPayForLog } from "@/lib/billing";
import { payPeriodFor } from "@/lib/pay-period";
import {
  AdminHourEntryNotConfirmedError,
  DuplicateHourLogError,
  HeldHourLogNotFoundError,
  HeldLogReviewRequiredError,
  HourLogNotFoundError,
  HourLogSubjectNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
  RejectReasonRequiredError,
} from "@/lib/errors";
import {
  adminLogHourForCoachSchema,
  createHourLogSchema,
  editHourLogSchema,
  MAX_HOUR_LOG_DURATION_MS,
} from "@/lib/schemas/hour-log";
import {
  findOverlappingLogs,
  overlappingLogMessage,
  type AdminHourEntryWarning,
} from "@/lib/admin-hour-entry";
import { findPayoutCovering, paidThroughMessage } from "@/lib/paid-through";
import {
  classifyManualLog,
  matchLogToBlock,
  type ReconBlock,
} from "@/lib/server/reconciliation";
import { formatPfaTime12h, pfaDayStart } from "@/lib/timezone";
import { recordStipendEarning } from "@/lib/stipend/earnings";
import { safeLogAudit } from "./audit-helpers";

// DESIGN-1: the (coach, program) pay mode + rates now live on a SINGLE
// program_rate_overrides row, fetched ONCE per log (in logHourInternal)
// and threaded into both pure resolvers below. The row's `payMode`
// decides which snapshot applies. Both resolvers are pure (no DB) so the
// branch space is unit-testable without mocks. `ProgramRateOverrideRow`
// is the inferred SELECT shape of the override row (null = no override).
type ProgramRateOverrideRow = typeof programRateOverrides.$inferSelect;

// The pay-relevant slice of a `programs` row. Taking the three fields (not
// just the hourly default, as before migration 0052) is what lets a PROGRAM
// carry a per-session rate instead of only a per-(coach, program) override.
// Callers pass the whole slice so the two resolvers can never disagree about
// which mode the program is in.
export type ProgramPayConfig = Pick<
  typeof programs.$inferSelect,
  | "payMode"
  | "defaultRatePer30MinCents"
  | "defaultPerSessionRateCents"
  // STIPEND SPEC §2.11 — in the Pick deliberately: adding it here makes every
  // caller's SELECT list fetch the column, so no resolution site can be handed
  // a program row that cannot answer the stipend question.
  | "stipendEligible"
>;

/** A usable money amount: a positive whole number of cents. */
function isPositiveCents(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * STIPEND SPEC §2.11 / §2.13 — is this (coach, program) pairing covered by the
 * coach's half-month stipend?
 *
 * 🔴 BOTH HALVES ARE REQUIRED, and the conjunction is the whole point:
 *  - the PROGRAM must be stipend-eligible (Mark's per-program switch), AND
 *  - the COACH must have a stipend amount in effect for the log's pay period.
 *
 * Requiring the coach half is what stops a NON-stipend coach who covers one
 * softball session from being silently paid $0 (SPEC §2.16a) — they simply are
 * not on a stipend, so they fall through to the program's normal rate. It is
 * the presence of an amount that puts a coach on a stipend; nothing else does.
 *
 * Pure and total: no DB, no clock. The caller resolves the amount for the
 * relevant period and passes it in.
 */
export function resolveStipendCovered(
  program: Pick<ProgramPayConfig, "stipendEligible"> | null,
  coachStipendAmountCents: number | null,
): boolean {
  return program?.stipendEligible === true && coachStipendAmountCents != null;
}

/**
 * The stipend amount in effect for `coachId` during the pay period that
 * contains `at`, or null when the coach is not on a stipend then.
 *
 * 🔴 RESOLVED AGAINST THE PERIOD'S START, NOT AGAINST `at` AND NOT AGAINST
 * "now". A stipend is earned for a whole half-month, so the version that
 * governs is the one in force at the period's first instant — that is what
 * makes the answer for September stable forever, no matter when the question
 * is asked or how many times the amount changes afterwards (SPEC §7.2, Q5).
 *
 * `coach_stipends` windows are non-overlapping per coach, so at most one row
 * can match; `limit(1)` is a safety net, not a tie-break. ⚠️ That non-overlap
 * is NOT enforced by a transaction — neon-http has none. It is structural: the
 * write path in `stipend-actions.ts` is append-only and forward-only, and the
 * batch that inserts a new version closes the previous one at exactly its
 * start, so the windows meet rather than overlap.
 */
export async function fetchStipendAmountCentsForPeriod(
  coachId: string,
  at: Date,
): Promise<number | null> {
  const periodStart = payPeriodFor(at).fromDate;
  const [row] = await db
    .select({ amountCents: coachStipends.amountCents })
    .from(coachStipends)
    .where(
      and(
        eq(coachStipends.coachId, coachId),
        lte(coachStipends.effectiveFrom, periodStart),
        or(
          isNull(coachStipends.effectiveTo),
          gt(coachStipends.effectiveTo, periodStart),
        ),
      ),
    )
    .limit(1);
  return row?.amountCents ?? null;
}

// Resolves the per-30-min cents HOURLY pay rate to stamp on a new
// hour_logs row, from the already-fetched (coach, program) override row.
// When the override is on "hourly" mode with a rate set, that rate wins;
// otherwise we fall back to the program's default_rate_per_30_min_cents
// (which may itself be null → $0 pay until an admin sets one). A
// per_session override has a null hourly rate and so also falls through
// to the program default here — harmless, since the per-session snapshot
// (below) is what the read path uses for those logs.
export function resolveRateCentsForProgram(
  override: ProgramRateOverrideRow | undefined | null,
  program: ProgramPayConfig | null,
  stipendCovered: boolean,
): number | null {
  // 🔴 STIPEND SPEC §2.11 — FIRST, AND AN EXPLICIT EARLY RETURN, NEVER A
  // FALL-THROUGH. This function ends in `return program?.defaultRate… ?? null`,
  // so a covered log that merely failed the override branch would land on the
  // PROGRAM DEFAULT and be paid hourly — on top of the stipend that already
  // paid for it. Every gate would stay green: the rate is a real configured
  // number and the hours are correct. That is the most expensive defect
  // available in this feature, and this line is what prevents it.
  //
  // The argument is REQUIRED, not optional, so TypeScript fails the build at
  // every call site — present and future — until each one answers the stipend
  // question. A default would let a new caller silently opt out.
  if (stipendCovered) return null;
  if (
    override &&
    override.payMode === "hourly" &&
    override.ratePer30MinCents != null
  ) {
    return override.ratePer30MinCents;
  }
  // A per_session PROGRAM has no hourly basis of its own — the flat amount
  // stamped by resolvePerSessionRateCents is the whole pay. Returning the
  // program's (possibly stale) hourly default here would leave a misleading
  // snapshot on the row.
  //
  // NOTE this branch is unreachable for every program that existed before
  // migration 0052: they all backfill to payMode="hourly", so the line below
  // is the ONLY one that runs for them — behavior is byte-identical until an
  // admin deliberately flips a program to per-session.
  if (program?.payMode === "per_session") {
    return null;
  }
  return program?.defaultRatePer30MinCents ?? null;
}

// DESIGN-1 — resolves the per-session pay snapshot (cents) to stamp on a new
// hour_logs row, from the same already-fetched (coach, program) override row.
// Returns the override's perSessionRateCents ONLY when that override is on the
// "per_session" pay mode with a positive integer amount; otherwise null (every
// hourly override, every (coach, program) pair with no override row, and any
// per_session override with a missing/non-positive amount → the hourly
// ratePer30MinCents snapshot applies instead). Preserves the immutable-snapshot
// rule: changing a coach's per-program mode never re-rates existing logs.
export function resolvePerSessionRateCents(
  override: ProgramRateOverrideRow | undefined | null,
  program: ProgramPayConfig | null,
  stipendCovered: boolean,
): number | null {
  // 🔴 STIPEND SPEC §2.11 — stated explicitly even though the `if (override)`
  // branch below already returns null for every non-per_session override.
  // ⚠️ THAT IS AN ACCIDENT OF CONTROL FLOW, NOT A CONTRACT: it does not hold
  // when there is NO override row (the branch is skipped entirely and the
  // PROGRAM's per-session default can win), and the next edit to this function
  // could take it away with nobody noticing. Relying on it would make a
  // double-pay depend on a coincidence.
  if (stipendCovered) return null;
  // A (coach, program) override WINS OUTRIGHT — including an HOURLY one,
  // which returns null here on purpose so that coach is paid hourly even on
  // a per-session program. Coach-specific always beats the program default,
  // consistent with how every other rate in this system resolves.
  // ⚠️ Operational consequence: flipping a program to per-session does NOT
  // reach coaches who hold an hourly override on it — those overrides must be
  // deleted, or they keep being paid by the clock. The Work tab warns about
  // this; see the per-session banner in program-form-dialog.
  if (override) {
    if (
      override.payMode === "per_session" &&
      isPositiveCents(override.perSessionRateCents)
    ) {
      return override.perSessionRateCents;
    }
    return null;
  }
  // No override → the PROGRAM's pay mode decides. This is the branch that
  // fixes "HS Summer Travel - Game": a flat fee per game logged, regardless
  // of how many hours the game ran.
  if (
    program?.payMode === "per_session" &&
    isPositiveCents(program.defaultPerSessionRateCents)
  ) {
    return program.defaultPerSessionRateCents;
  }
  return null;
}

/**
 * SPEC rate-effective-dating §5 — PROVENANCE of the rate snapshot stamped on a
 * new hour_logs row. Answers "where did that number come from?", nothing more.
 *
 * ⚠️ INFORMATIONAL ONLY. Nothing in this function may ever influence WHICH
 * rate is stamped, and no pay calculation may ever read the column it feeds
 * (`hourLogs.rateSourceKind`). The money still comes exclusively from the two
 * snapshots resolved above. This exists so the Phase-B retro re-price engine
 * can tell, without inferring, which logs were paid from a program default and
 * are therefore in scope for a program-level retro (§5).
 *
 * Derived by asking the SAME two resolvers, with the SAME already-fetched
 * override + program rows, which one produced the non-null value — so the
 * provenance can never disagree with the rate that was actually stamped:
 *
 *  - "override"        the (coach, program) override supplied the rate
 *  - "program_default" the program's default supplied it
 *  - "none"            neither did (the $0-loud case)
 */
export function resolveRateSourceKind(
  override: ProgramRateOverrideRow | undefined | null,
  program: ProgramPayConfig | null,
  stipendCovered: boolean,
): "override" | "program_default" | "none" {
  // STIPEND SPEC §2.11 — forwarded so provenance is derived from the SAME
  // answer the two rate resolvers were given; asking them a different question
  // than the one that produced the stamped rate is how provenance drifts.
  //
  // 📌 A covered log resolves to "none", and that is HONEST rather than a
  // fallback: neither the override nor the program default supplied a rate.
  // The `rate_source_kind` PG enum is deliberately NOT widened — no
  // `ALTER TYPE`, which Postgres cannot use in the same transaction that adds
  // it. `hour_logs.stipend_covered` is what distinguishes "covered by stipend"
  // from "nobody ever set a rate"; the two must never read the same way.
  // Per-session takes precedence: when a flat amount is stamped, it IS the
  // pay for the log (billing.ts reads it ahead of the hourly snapshot).
  // resolvePerSessionRateCents returns non-null from exactly two places — the
  // override's own per_session amount, or, when there is NO override row at
  // all, the program's per_session default.
  if (resolvePerSessionRateCents(override, program, stipendCovered) != null) {
    return override ? "override" : "program_default";
  }
  // Otherwise the hourly snapshot is the pay. resolveRateCentsForProgram
  // returns the override's rate under exactly this condition; every other
  // non-null result there came from program.defaultRatePer30MinCents.
  if (resolveRateCentsForProgram(override, program, stipendCovered) != null) {
    return override &&
      override.payMode === "hourly" &&
      override.ratePer30MinCents != null
      ? "override"
      : "program_default";
  }
  // Neither snapshot resolved → the log is worth $0 and nothing supplied a
  // rate. Recorded loudly rather than left ambiguous.
  return "none";
}

/**
 * WHO is writing an hour log, and WHOSE hours it records.
 *
 * 🔴 THESE WERE THE SAME PERSON ON EVERY PATH THE PRODUCT HAD UNTIL NOW, which
 * is exactly why `logHourInternal` could stamp `actor.id` into eight different
 * places and stay correct: the rate override it looks up, the stipend window
 * it resolves, the schedule blocks it classifies against, the row's
 * `coach_id`, the row's `created_by`, the duplicate re-select, the audit
 * actor, and the stipend earning's actor. An admin recording a coach's hours
 * breaks that identity, and every one of those eight sites has to be told
 * which of the two people it meant.
 *
 * Making `subjectCoachId` a REQUIRED field rather than an optional override is
 * the whole point — the compiler enumerates the sites, a grep does not. That
 * is the same instrument that found the stipend's 61 pricing call sites, two
 * of which were in untracked tooling nobody would have grepped.
 */
type HourLogAuthor = {
  /**
   * The signed-in user performing the write. Stamped on `created_by` and on
   * every audit row, and NEVER on `coach_id`.
   */
  actor: AuthedSession["user"];
  /**
   * WHOSE hours these are. Stamped on `coach_id` — the column every pay read
   * groups by — and the identity used to resolve the rate override, the
   * stipend amount, and the schedule blocks the log is classified against.
   */
  subjectCoachId: string;
  /**
   * 🔴 WHICH ENTRY PATH THIS IS. Not a label: it decides three behaviours, and
   * each one is a deliberate difference rather than a shortcut.
   *
   *  - `coach_self` — a coach logging their own hours. The 1b-security-B
   *    held-then-approve anomaly gate RUNS, an inactive program is refused,
   *    and the row is left unreviewed so the needs-review queue can see it.
   *
   *  - `admin_for_coach` — an admin recording a coach's hours. The anomaly
   *    gate does NOT run: it exists to route a COACH's odd entry to an admin
   *    for a decision, and when the admin IS the author the routing is
   *    circular and the decision has already been made. An inactive program is
   *    accepted, because work done in June against a program retired in August
   *    still happened and still has to be payable. And the row is stamped
   *    reviewed, for the same reason the gate is skipped — putting an admin's
   *    own entry into the admin's own review queue asks him to check his own
   *    typing.
   */
  via: "coach_self" | "admin_for_coach";
};

/**
 * The one function that writes a new `hour_logs` row. Both entry points — a
 * coach logging their own hours and an admin recording a coach's — run this
 * exact code, and that is a safety property rather than tidiness:
 *
 *  - **Pricing cannot fork.** The rate snapshot, the per-session snapshot and
 *    `stipend_covered` are resolved here, once, by the same three resolvers.
 *    Identical work therefore cannot price differently depending on who typed
 *    it in.
 *  - **The duplicate rule cannot fork.** `onConflictDoNothing` plus the
 *    held → posted upgrade below is the ONLY duplicate handling in the
 *    product. A second implementation for admins is the most likely way this
 *    feature would have produced a double-pay.
 *  - **The stipend trigger does not gain a call site.** An admin entry is a
 *    new posted moment, and it earns because it runs the same two
 *    `recordStipendEarning` calls the coach path already runs. Nothing had to
 *    be remembered; there is nowhere for it to be forgotten.
 */
async function writeHourLogInternal(author: HourLogAuthor, input: unknown) {
  const { actor, subjectCoachId } = author;
  const isAdminEntry = author.via === "admin_for_coach";
  const parsed = createHourLogSchema.parse(input);

  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, parsed.programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(parsed.programId);
  // 🔴 THE ACTIVE CHECK IS COACH-SIDE ONLY, AND THAT IS THE POINT OF THE
  // ADMIN PATH. It guards the CREATE path where a coach picks a program from a
  // live list — nobody should be able to start logging against something
  // retired. An admin recording historical hours is the opposite case: the
  // headline scenario for this feature is a coach who left in July whose last
  // three shifts were never logged, and the summer program they worked has
  // since been switched off. Refusing would mean deactivate-log-reactivate as
  // a routine workaround, which makes the program pickable by every coach in
  // between — a worse outcome reached by a stricter-looking rule.
  if (!program.active && !isAdminEntry) {
    throw new ProgramInactiveError(program.id, program.name);
  }

  // DESIGN-1: fetch the (coach, program) override row ONCE — its payMode
  // decides BOTH pay snapshots below. Per-program now, not coach-wide.
  // 🔴 Keyed on the SUBJECT, never the actor: the rate that applies is the
  // one the coach who did the work holds, not the one the admin typing it in
  // happens to have.
  const [override] = await db
    .select()
    .from(programRateOverrides)
    .where(
      and(
        eq(programRateOverrides.coachId, subjectCoachId),
        eq(programRateOverrides.programId, parsed.programId),
      ),
    )
    .limit(1);

  // STIPEND SPEC §2.11 — resolved BEFORE the three rate resolvers, because all
  // three take it as a required argument. Covered work stamps NO rate and pays
  // $0: the coach's half-month stipend is the pay for it.
  //
  // ⚠️ Keyed on the LOG's own `startAt`, never on "now" — backdating a log into
  // an earlier period must resolve that period's stipend, not today's. That
  // was already true for a coach backdating their own log; it matters far more
  // here, because backdating is the admin path's ordinary case rather than its
  // edge case.
  const stipendAmountCents = await fetchStipendAmountCentsForPeriod(
    subjectCoachId,
    parsed.startAt,
  );
  const stipendCovered = resolveStipendCovered(program, stipendAmountCents);

  // Stamp the resolved HOURLY pay rate as a snapshot (cents per 30-min
  // slot), mirroring sessions_billing. May be null when neither the
  // override nor the program sets a rate → $0 pay; reads treat null as 0.
  //
  // 📌 RESOLVED AT TODAY'S CONFIGURATION, INCLUDING FOR A BACKDATED ENTRY, and
  // that is deliberate rather than an oversight. `program_rate_overrides
  // .effective_from` is documented in the schema as a RE-PRICING INSTRUCTION,
  // not a resolution rule (rate-effective-dating SPEC §4): no resolver
  // consults it, on any path. Retroactive corrections are made explicitly
  // through `rate-reprice.ts`, which re-runs these same resolvers over a date
  // range. Teaching THIS path to resolve as-of the log's date would create
  // exactly the fork the shared core exists to prevent — an admin-entered
  // June log priced differently from the coach-entered June log beside it.
  // ⚠️ The operational consequence, worth knowing rather than coding around:
  // hours backdated into a window that has already been re-priced land at
  // today's rate. Re-running the re-price for that window is the remedy.
  const ratePer30MinCents = resolveRateCentsForProgram(
    override,
    program,
    stipendCovered,
  );

  // DESIGN-1 — per-session pay snapshot. Non-null only when this
  // (coach, program) override is on the "per_session" pay mode with a
  // positive amount; otherwise null = hourly basis (the ratePer30MinCents
  // snapshot above applies). Snapshotted alongside the hourly rate so a
  // later mode change never re-rates this log. Applies to ALL insert paths
  // (coach self-log, schedule-confirm auto-confirm, held, admin entry).
  const perSessionRateCents = resolvePerSessionRateCents(
    override,
    program,
    stipendCovered,
  );

  // SPEC rate-effective-dating §5 — record WHERE the rate above came from.
  // Same `override` + `program` rows the two resolvers just used, so the
  // provenance and the rate can never disagree. Purely informational: it does
  // not change what gets stamped, and no pay math reads it.
  const rateSourceKindValue = resolveRateSourceKind(
    override,
    program,
    stipendCovered,
  );

  // 1b security B — held-then-approve gate. Runs for EVERY coach-side source.
  // The `source` flag (client-supplied) must NOT be able to bypass this check:
  // a forged source:"schedule-confirm" with no matching block would
  // otherwise post immediately as payable (P0 payroll-fraud). Instead we
  // ALWAYS fetch the SUBJECT's scheduled MEMBER blocks overlapping the log
  // window (same join as the coach history page) and classify the log.
  // A clean log posts as today — this is exactly what the trusted
  // auto-confirm hotlink sends (the block's EXACT start/end/program), so it
  // still posts instantly. An anomalous log is either held (coach
  // acknowledged) or refused with a thrown error the form turns into a
  // "send for approval / go back and edit" warning.
  //
  // 🔴 SKIPPED ENTIRELY ON THE ADMIN PATH — see `HourLogAuthor.via`. The gate's
  // job is to get a second person to look at an odd entry, and on that path
  // the second person is the one entering it. Note what this does NOT skip:
  // the admin path runs its own guards BEFORE reaching here (an overlapping
  // existing log, and a period already paid out), which are the checks that
  // actually protect money. Skipping a review step is safe only because those
  // exist — see `logHourForCoachInternal`.
  let heldReason: "unscheduled" | "wrong_time" | "over_logged" | null = null;
  if (!isAdminEntry) {
    const blockRows = await db
      .select({
        id: programScheduleBlocks.id,
        programId: programScheduleBlocks.programId,
        startAt: programScheduleBlocks.startAt,
        endAt: programScheduleBlocks.endAt,
      })
      .from(programScheduleBlocks)
      .innerJoin(
        programScheduleBlockCoaches,
        eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
      )
      .where(
        and(
          eq(programScheduleBlockCoaches.coachId, subjectCoachId),
          // Half-open overlap with the log window.
          lt(programScheduleBlocks.startAt, parsed.endAt),
          gte(programScheduleBlocks.endAt, parsed.startAt),
        ),
      );
    // ReconBlock[] — all blocks are the subject's own, so the in-set checks
    // inside the classifier are satisfied implicitly. Names are unused by
    // classifyManualLog, so pass "".
    const blocks: ReconBlock[] = blockRows.map((b) => ({
      id: b.id,
      programId: b.programId,
      scheduledCoachId: subjectCoachId,
      scheduledCoachName: "",
      coaches: [{ coachId: subjectCoachId, coachName: "" }],
      startAt: b.startAt,
      endAt: b.endAt,
    }));

    const anomaly = classifyManualLog(
      {
        coachId: subjectCoachId,
        programId: parsed.programId,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
      },
      blocks,
      formatPfaTime12h,
    );

    if (anomaly.kind !== "clean") {
      if (parsed.acknowledgeHold !== true) {
        // No write — the coach must explicitly send it for approval.
        throw new HeldLogReviewRequiredError(anomaly.kind, anomaly.message);
      }
      heldReason = anomaly.kind;
    }
  }

  // 🔴 AN ADMIN ENTRY IS STAMPED REVIEWED AT INSERT, AND THIS IS COUPLED TO
  // THE GUARDS ABOVE — do not separate them.
  //
  // `fetchNeedsReviewItems` surfaces any posted log with a null `reviewed_at`
  // that is unscheduled, double-logged, or off its block's times. An admin
  // recording work that never had a schedule block produces an `unscheduled`
  // row every single time, which would put the admin's own typing into the
  // admin's own queue — and a queue that fills with self-generated items is a
  // queue people stop reading, which is rule 38 arriving from the other
  // direction.
  //
  // ⚠️ WHAT THIS SUPPRESSES, STATED OUT LOUD: the `double_logged` alert. That
  // is acceptable ONLY because `logHourForCoachInternal` refuses an
  // overlapping entry outright unless the admin confirms it, which catches the
  // same money defect BEFORE the row is written rather than after. If that
  // guard is ever removed, this stamp must go with it — otherwise a partial
  // overlap would be written silently and reported nowhere.
  // 📌 `wrong_time` is NOT suppressed in any meaningful sense: it still paints
  // the block red on /admin/hour-log/schedule, which is the surface that
  // carries the one-click resolution for it.
  const reviewStamp = isAdminEntry
    ? { reviewedAt: new Date(), reviewedBy: actor.id }
    : {};

  // Idempotent insert: the hour_logs_coach_program_start_end_unique index
  // (mig 0029) makes an exact (coach, program, start, end) a true duplicate.
  // onConflictDoNothing means a double-confirm/double-tap (or a race between
  // two tabs/devices) never writes a second paid row — the second attempt
  // returns an EMPTY array, which we treat as a graceful no-op by returning
  // the already-logged row (no error, no duplicate audit entry).
  const [inserted] = await db
    .insert(hourLogs)
    .values({
      coachId: subjectCoachId,
      programId: parsed.programId,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      note: parsed.note ?? null,
      ratePer30MinCents,
      perSessionRateCents,
      rateSourceKind: rateSourceKindValue,
      // STIPEND SPEC §3.3 — the immutable record that this log's $0 is a
      // DECISION, not a missing rate. Read by every display so a covered row
      // says "Covered by stipend" instead of "No rate" beside real hours.
      stipendCovered,
      // 🔴 THE ACTOR, NOT THE SUBJECT — and this is the whole provenance
      // story. Until the admin path existed, every row in the product had
      // `created_by = coach_id`, because the only insert stamped both from
      // the session. So `created_by <> coach_id` now means, unambiguously and
      // with no historical false positives, "an admin entered this on the
      // coach's behalf". That is why this feature needed no migration and no
      // new column: the marker was already there, waiting for the two values
      // to differ.
      createdBy: actor.id,
      ...reviewStamp,
      // A clean/auto-confirm log omits status → relies on the "posted"
      // default. Only the held branch stamps status + heldReason, and the
      // admin path can never reach it.
      ...(heldReason !== null
        ? { status: "held" as const, heldReason }
        : {}),
    })
    .onConflictDoNothing({
      target: [
        hourLogs.coachId,
        hourLogs.programId,
        hourLogs.startAt,
        hourLogs.endAt,
      ],
    })
    .returning();

  if (!inserted) {
    // Conflict: an identical log already exists. The unique index does NOT
    // include `status`, so a held row + a later CLEAN confirm of the exact
    // same window both collide here.
    const [existing] = await db
      .select()
      .from(hourLogs)
      .where(
        and(
          eq(hourLogs.coachId, subjectCoachId),
          eq(hourLogs.programId, parsed.programId),
          eq(hourLogs.startAt, parsed.startAt),
          eq(hourLogs.endAt, parsed.endAt),
        ),
      )
      .limit(1);

    // 🔴 WHETHER THIS WRITE CARRIES THE AUTHORITY TO APPROVE A HELD ROW.
    //
    // Stated as a named condition rather than reusing `heldReason === null`,
    // even though the two agree on both paths today. On the admin path
    // `heldReason` is null because the classifier never ran, so leaning on it
    // would make an approval — a payroll decision — depend on the incidental
    // initial value of an unrelated variable. A future edit that gave
    // `heldReason` a default, or ran the classifier for reporting, would flip
    // an approval rule with nothing in the diff suggesting it had.
    //
    //  - coach: only a CLEAN re-confirm approves, i.e. one that matched a
    //    scheduled block. An anomalous attempt leaves the row held, which is
    //    the entire point of the gate.
    //  - admin: always. Mark entering the hours IS the approval — that is
    //    decision 3 of the feature, and refusing here would leave him looking
    //    at a held row he cannot clear by doing the obvious thing.
    const approvesHeldDuplicate = isAdminEntry || heldReason === null;

    // Held → posted upgrade: if the existing row is stuck "held" (awaiting
    // admin approval, unpaid, excluded from counts) AND this write carries
    // approval authority, treat it as the approval. We mirror
    // approveHeldHourLogInternal exactly: flip status → "posted" and stamp
    // reviewedAt/reviewedBy so the row also leaves the needs-review queue,
    // plus clear the stale heldReason. We do NOT downgrade an already-"posted"
    // row.
    if (existing && existing.status === "held" && approvesHeldDuplicate) {
      const [upgraded] = await db
        .update(hourLogs)
        .set({
          status: "posted",
          heldReason: null,
          reviewedAt: new Date(),
          reviewedBy: actor.id,
        })
        .where(eq(hourLogs.id, existing.id))
        .returning();

      await safeLogAudit(db, {
        actorUserId: actor.id,
        entityType: "hour_log",
        entityId: existing.id,
        action: "update",
        before: existing as unknown as Record<string, unknown>,
        after: upgraded as unknown as Record<string, unknown>,
      });

      // 🔴 POSTED MOMENT 2 of 3 — the HELD → POSTED auto-upgrade. This branch
      // is a long way from the insert below and is the one a reader misses:
      // it is an UPDATE inside the duplicate-conflict path. `stipendCovered`
      // comes off the EXISTING row's snapshot, stamped when the held row was
      // first written.
      await recordStipendEarning({
        actorUserId: actor.id,
        coachId: upgraded.coachId,
        hourLogId: upgraded.id,
        logStartAt: upgraded.startAt,
        stipendCovered: upgraded.stipendCovered,
        resolveAmountCents: fetchStipendAmountCentsForPeriod,
      });
      return upgraded;
    }

    // Otherwise an identical log already exists in its current state
    // (already posted, or still legitimately held by an anomalous attempt).
    // Return it unchanged without writing a duplicate audit row.
    return existing;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });

  // 🔴 POSTED MOMENT 1 of 3 — a clean log takes the schema's `posted` default.
  // Gated on the row's OWN status rather than on `heldReason === null`: the
  // two agree today, and reading the status is the one that stays true if the
  // insert's status handling ever changes.
  if (inserted.status === "posted") {
    await recordStipendEarning({
      actorUserId: actor.id,
      coachId: inserted.coachId,
      hourLogId: inserted.id,
      logStartAt: inserted.startAt,
      stipendCovered: inserted.stipendCovered,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
    });
  }
  return inserted;
}

/**
 * A coach logs their OWN hours. The subject is the actor — which is what every
 * hour log in the product was until the admin path below existed.
 */
export async function logHourInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  return writeHourLogInternal(
    { actor, subjectCoachId: actor.id, via: "coach_self" },
    input,
  );
}

/**
 * Every warning this entry raises, in the order the admin should read them:
 * the money consequence first, the bookkeeping consequence second.
 *
 * Returns an empty array when there is nothing to say, which is the ordinary
 * case — a first-time entry for a recent shift raises nothing at all.
 */
async function collectAdminHourEntryWarnings(
  subject: { id: string; label: string },
  window: { programId: string; startAt: Date; endAt: Date },
): Promise<AdminHourEntryWarning[]> {
  const warnings: AdminHourEntryWarning[] = [];

  // ── 1. Does an existing log of this coach's already cover these hours? ──
  //
  // 🔴 THE MOST EXPENSIVE MISTAKE THIS FEATURE MAKES REACHABLE. The unique
  // index catches an EXACT (coach, program, start, end) repeat and nothing
  // else, so a coach who logged 10:00–3:00 and an admin who types 10:00–2:00
  // produce two payable rows for the same hours — both legal by every
  // constraint in the database.
  //
  // The scan is bounded by `startAt > windowStart − MAX_HOUR_LOG_DURATION_MS`,
  // which is EXACT rather than approximate: no log may be longer than that, so
  // any log starting earlier than the bound has already ended before this
  // window opens and cannot overlap it. It rides the existing
  // `hour_logs_coach_start_idx`. The overlap PREDICATE itself is deliberately
  // NOT in the SQL — it lives once, in the pure module, where it is tested
  // against the endpoint cases, rather than being written a second time here
  // in a dialect where an off-by-one is invisible.
  const overlapScanFrom = new Date(
    window.startAt.getTime() - MAX_HOUR_LOG_DURATION_MS,
  );
  const nearbyRows = await db
    .select({
      id: hourLogs.id,
      programId: hourLogs.programId,
      programName: programs.name,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      status: hourLogs.status,
    })
    .from(hourLogs)
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    .where(
      and(
        eq(hourLogs.coachId, subject.id),
        // `rejected` rows are excluded from every pay/report/accountability
        // read, so one cannot be double-paid and must not raise a warning.
        or(eq(hourLogs.status, "posted"), eq(hourLogs.status, "held")),
        gt(hourLogs.startAt, overlapScanFrom),
        lt(hourLogs.startAt, window.endAt),
      ),
    );

  const overlaps = findOverlappingLogs(
    window,
    nearbyRows
      // 🔴 AN EXACT MATCH IS NOT A DOUBLE-PAY, SO IT MUST NOT WARN LIKE ONE.
      // Same program, same start, same end is precisely what the unique index
      // and the conflict branch below handle: a posted twin makes the write a
      // graceful no-op, and a held twin is upgraded to posted. Warning "this
      // pays them twice" over a case the database structurally prevents is a
      // true-sounding reason attached to the wrong situation, and an admin who
      // confirms through one false warning confirms through the next real one.
      .filter(
        (r) =>
          !(
            r.programId === window.programId &&
            r.startAt.getTime() === window.startAt.getTime() &&
            r.endAt.getTime() === window.endAt.getTime()
          ),
      )
      .map((r) => ({
        id: r.id,
        programName: r.programName,
        startAt: r.startAt,
        endAt: r.endAt,
        // Narrowed from the column's three-value enum by the query above.
        status: r.status as "posted" | "held",
      })),
  );
  if (overlaps.length > 0) {
    warnings.push({
      kind: "overlapping_log",
      message: overlappingLogMessage(subject.label, overlaps),
    });
  }

  // ── 2. Has this coach already been paid for the day these hours fall on? ──
  //
  // Every tagged PFA→coach payout for the coach is fetched and the DECISION is
  // made in the pure module, rather than filtering by `covers_through` in SQL.
  // That keeps one implementation of the boundary rule — which is inclusive of
  // the named day, and is the case most likely to be got wrong — in the place
  // where it is unit-tested. The row count is tiny (the entire production
  // table held 20 rows across all coaches when this was written).
  //
  // A NULL `covers_through` is untagged money: it makes no claim about any
  // day, so it is excluded at the query rather than guessed at from `paid_at`
  // (payment-statement SPEC §4 — that guess is what the column exists to
  // prevent).
  const payoutRows = await db
    .select({
      id: coachPayments.id,
      amountCents: coachPayments.amountCents,
      paidAt: coachPayments.paidAt,
      coversThrough: coachPayments.coversThrough,
      status: coachPayments.status,
    })
    .from(coachPayments)
    .where(
      and(
        eq(coachPayments.coachId, subject.id),
        eq(coachPayments.direction, "pfa_to_coach"),
        isNull(coachPayments.deletedAt),
        isNotNull(coachPayments.coversThrough),
      ),
    );

  const finding = findPayoutCovering(
    // PFA-midnight of the log's own date. The guard is about the DAY the work
    // happened; comparing a 6 PM start against a midnight coverage date would
    // spare every log written after 00:00.
    pfaDayStart(window.startAt),
    payoutRows.map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      paidAt: r.paidAt,
      // Non-null by the isNotNull filter above; the column type cannot say so.
      coversThrough: r.coversThrough as Date,
      status: r.status,
    })),
  );
  if (finding) {
    warnings.push({
      kind: "already_paid_through",
      message: paidThroughMessage(subject.label, window.startAt, finding),
    });
  }

  return warnings;
}

/**
 * 🔴 AN ADMIN RECORDS HOURS ON A COACH'S BEHALF.
 *
 * THE GAP THIS CLOSES. Before this existed there was exactly ONE
 * `insert(hourLogs)` site in `src`, reachable only from
 * `src/app/coach/hour-log/actions.ts`, which stamps `coach_id` from the authed
 * session — so ONLY A COACH COULD CREATE THEIR OWN HOUR LOG. An admin could
 * edit one and delete one, but could not make one. A coach who quit, lost
 * access, or simply would not log took their unlogged pay with them, and no
 * admin action anywhere could put it back. Pay derives from `hour_logs`, so
 * putting the right coach on the SCHEDULE instead produces no pay at all,
 * silently, while looking handled.
 *
 * Posts immediately: the admin entering the hours IS the approval.
 *
 * No date limit, deliberately — and note there was never one to remove. The
 * 14-day bound people remember is `LOOKBACK_MS` on the coach's one-tap confirm
 * CARDS; the manual coach form has only "end after start" and "≤ 16 hours".
 * Any day of any month is enterable here, which is the point.
 *
 * ── THE ORDER OF THE CHECKS IS THE DESIGN ────────────────────────────────
 *  1. The subject must be a live account — refused outright, never confirmable.
 *  2. Everything money-consequential is collected and shown as ONE amber
 *     decision the admin confirms.
 *  3. Only then does the shared core run, and it prices the log through the
 *     exact resolvers a coach's own log goes through.
 */
export async function logHourForCoachInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = adminLogHourForCoachSchema.parse(input);

  // The subject lands on `coach_id`, the column every pay read groups by, so
  // it is resolved against the database rather than trusted from the form.
  //
  // 📌 ROLE IS DELIBERATELY NOT FILTERED, unlike the coach pickers. Admins
  // genuinely have work logs in this system — Mark has one — and `hour_logs
  // .coach_id` references `users`, not a coach-only view. Filtering to
  // `role = 'coach'` here would refuse a real, already-existing case.
  // Soft-deleted accounts ARE refused: a payable log against a deleted user is
  // money owed to nobody, on no coach's statement, reachable by no UI.
  const [subject] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.id, parsed.coachId), isNull(users.deletedAt)))
    .limit(1);
  if (!subject) throw new HourLogSubjectNotFoundError(parsed.coachId);

  const label = subject.name ?? subject.email;

  // 🔴 RE-RUN SERVER-SIDE, ALWAYS. The dialog shows these warnings before the
  // admin confirms, but the dialog is not the control: a stale render, a
  // second tab, or a direct RPC call would otherwise walk straight past them.
  // `confirmWarnings` unlocks only a refusal the server has just independently
  // decided is warranted — it is permission, never evidence.
  const warnings = await collectAdminHourEntryWarnings(
    { id: subject.id, label },
    { programId: parsed.programId, startAt: parsed.startAt, endAt: parsed.endAt },
  );
  if (warnings.length > 0 && parsed.confirmWarnings !== true) {
    throw new AdminHourEntryNotConfirmedError(warnings);
  }

  return writeHourLogInternal(
    { actor, subjectCoachId: subject.id, via: "admin_for_coach" },
    parsed,
  );
}

// Admin-only edit of an existing hour-log row. Mirrors
// updateSessionInternal: fetch the existing row, Zod-parse the desired
// state, persist, then audit a changed-keys-only diff (before/after).
//
// The admin edit surface only changes times/note (the row stays bound
// to its original program), so we do NOT re-run the active-program
// check here — that guards the CREATE path where a coach picks a
// program. editHourLogSchema still validates endAt > startAt (DB CHECK
// is canonical; this gives a friendly error).
export async function updateHourInternal(
  actor: AuthedSession["user"],
  id: string,
  input: unknown,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  const parsed = editHourLogSchema.parse(input);

  const [updated] = await db
    .update(hourLogs)
    .set({
      programId: parsed.programId,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      note: parsed.note ?? null,
    })
    .where(eq(hourLogs.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });

  // 🔴 A TIME EDIT CAN MOVE A POSTED LOG INTO A DIFFERENT PAY PERIOD.
  //
  // The trigger's rule is "an hour log becomes POSTED", and an edit is not a
  // post — so correcting a date from Sep 3 to Sep 20 moved real covered work
  // into 2026-09-P2 while NOTHING ever earned that period's stipend. The coach
  // was silently short a half-month, and the only evidence was an absence.
  //
  // Safe to call unconditionally on this path: the upsert is idempotent
  // (`UNIQUE (coach_id, period_key)`), it never removes an earning, and it
  // never throws into the caller. So it can only ever ADD a period that should
  // already have been there — an edit WITHIN one period earns nothing new, and
  // the ORIGINAL period's earning still stands, which is Mark's Q3 answer.
  if (updated.status === "posted") {
    await recordStipendEarning({
      actorUserId: actor.id,
      coachId: updated.coachId,
      hourLogId: updated.id,
      logStartAt: updated.startAt,
      stipendCovered: updated.stipendCovered,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
    });
  }
  return updated;
}

// Admin-only hard delete of an hour-log row. hour_logs has no
// soft-delete column — it's a simple log entry — so we DELETE outright
// and capture the full `before` snapshot in the audit row. Mirrors
// deleteSessionInternal.
export async function deleteHourInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  await db.delete(hourLogs).where(eq(hourLogs.id, id));
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
  });
}

// Admin-only "Resolve" — mark an unscheduled hour-log reviewed/acknowledged.
// The row STAYS (real worked time/pay); stamping reviewedAt just drops it off
// the needs-review queue. Idempotent: if the row is already reviewed we keep
// the original reviewer/timestamp and return it unchanged (never overwrite).
// We deliberately do NOT verify the row is actually unscheduled — stamping a
// scheduled row is harmless (it simply never surfaces a Resolve button).
export async function resolveHourLogInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  // Idempotent — already reviewed, keep the original reviewer.
  if (existing.reviewedAt) return existing;

  const [updated] = await db
    .update(hourLogs)
    .set({ reviewedAt: new Date(), reviewedBy: actor.id })
    .where(eq(hourLogs.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

// 1b security B — admin APPROVE of a held manual log. Flips status to
// "posted" so it becomes payable + counted everywhere. We also stamp
// reviewedAt/reviewedBy so an approved formerly-unscheduled log ALSO leaves
// the needs-review queue (same marker resolveHourLogInternal uses). Throws
// HeldHourLogNotFoundError if the row is missing or no longer held (another
// tab already resolved it).
export async function approveHeldHourLogInternal(
  actor: AuthedSession["user"],
  id: string,
  edit?: { startAt: Date; endAt: Date },
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing || existing.status !== "held") {
    throw new HeldHourLogNotFoundError(id);
  }

  let updated;
  try {
    [updated] = await db
      .update(hourLogs)
      .set({
        status: "posted",
        reviewedAt: new Date(),
        reviewedBy: actor.id,
        ...(edit ? { startAt: edit.startAt, endAt: edit.endAt } : {}),
      })
      // Guard the WRITE on status='held' too (not just the SELECT above):
      // neon-http can't transact, so another tab resolving this row between
      // our SELECT and UPDATE would otherwise slip through. If it already
      // moved, the update matches 0 rows and we treat it as already-resolved.
      .where(and(eq(hourLogs.id, id), eq(hourLogs.status, "held")))
      .returning();
  } catch (err) {
    if (edit && isHourLogDuplicateViolation(err)) {
      throw new DuplicateHourLogError();
    }
    throw err;
  }
  if (!updated) throw new HeldHourLogNotFoundError(id);

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });

  // 🔴 POSTED MOMENT 3 of 3 — an admin approving a held log.
  // ⚠️ `updated.startAt` deliberately, NOT `existing.startAt`: an approval may
  // carry a time EDIT, and the edited time is what decides the pay period.
  // Approving a September log in October must earn a SEPTEMBER stipend — the
  // approval date never buckets anything.
  await recordStipendEarning({
    actorUserId: actor.id,
    coachId: updated.coachId,
    hourLogId: updated.id,
    logStartAt: updated.startAt,
    stipendCovered: updated.stipendCovered,
    resolveAmountCents: fetchStipendAmountCentsForPeriod,
  });
  return updated;
}

// 1b security B — admin REJECT of a held manual log. DELETEs the row (the
// coach must re-enter corrected data — there's no lingering rejected state)
// and captures the full `before` snapshot in the audit row, threading the
// optional admin note into the audit `after` payload. Throws
// HeldHourLogNotFoundError if the row is missing or no longer held.
export async function rejectHeldHourLogInternal(
  actor: AuthedSession["user"],
  id: string,
  adminNote?: string,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing || existing.status !== "held") {
    throw new HeldHourLogNotFoundError(id);
  }

  await db.delete(hourLogs).where(eq(hourLogs.id, id));
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
    ...(adminNote ? { after: { adminNote } } : {}),
  });
}

// Postgres SQLSTATE 23505 — unique_violation, specifically the
// hour_logs_coach_program_start_end_unique index. Neon's HTTP driver wraps
// errors, so we walk the cause chain (same shape as program-actions'
// isProgramNameViolation). We additionally match the constraint name so a
// future second unique constraint on hour_logs wouldn't get mistranslated.
function isHourLogDuplicateViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as { code?: unknown; constraint?: unknown };
    if (e.code === "23505") {
      if (
        e.constraint === undefined ||
        e.constraint === "hour_logs_coach_program_start_end_unique"
      ) {
        return true;
      }
    }
  }
  if (err instanceof Error && err.cause) {
    return isHourLogDuplicateViolation(err.cause);
  }
  return false;
}

// Admin ACCEPTS a needs-review hour log: it stays posted (counts) and is
// marked reviewed. Idempotent. Mirrors resolveHourLogInternal but is the
// explicit "accepted" decision the coach is notified of.
//
// Optional `edit` lets the admin CORRECT the log's start/end times in the
// same action (e.g. a coach logged a 30-min-off time). Pay/hours are computed
// downstream from start/end × the snapshotted rate, so updating the times
// auto-corrects the money — we never touch the rate/snapshot, no migration.
// When `edit` is present we ALWAYS apply it (no idempotent short-circuit — the
// admin may be correcting times on an already-reviewed log); the audit diff
// captures the time change. Shifting onto an exact (coach, program, start, end)
// duplicate is caught (23505) and re-thrown as a friendly DuplicateHourLogError.
export async function acceptNeedsReviewLogInternal(
  actor: AuthedSession["user"],
  id: string,
  edit?: { startAt: Date; endAt: Date },
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  // Idempotent — already accepted (posted + reviewed), keep the original
  // reviewer/timestamp and return unchanged. Skipped when an edit is present:
  // the admin may be correcting times even on an already-reviewed log.
  if (!edit && existing.status === "posted" && existing.reviewedAt) {
    return existing;
  }

  let updated;
  try {
    [updated] = await db
      .update(hourLogs)
      .set({
        ...(edit ? { startAt: edit.startAt, endAt: edit.endAt } : {}),
        reviewedAt: new Date(),
        reviewedBy: actor.id,
      })
      .where(eq(hourLogs.id, id))
      .returning();
  } catch (err) {
    if (edit && isHourLogDuplicateViolation(err)) {
      throw new DuplicateHourLogError();
    }
    throw err;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });

  // 🔴 A TIME EDIT CAN MOVE A POSTED LOG INTO A DIFFERENT PAY PERIOD.
  //
  // The trigger's rule is "an hour log becomes POSTED", and an edit is not a
  // post — so correcting a date from Sep 3 to Sep 20 moved real covered work
  // into 2026-09-P2 while NOTHING ever earned that period's stipend. The coach
  // was silently short a half-month, and the only evidence was an absence.
  //
  // Safe to call unconditionally on this path: the upsert is idempotent
  // (`UNIQUE (coach_id, period_key)`), it never removes an earning, and it
  // never throws into the caller. So it can only ever ADD a period that should
  // already have been there — an edit WITHIN one period earns nothing new, and
  // the ORIGINAL period's earning still stands, which is Mark's Q3 answer.
  if (updated.status === "posted") {
    await recordStipendEarning({
      actorUserId: actor.id,
      coachId: updated.coachId,
      hourLogId: updated.id,
      logStartAt: updated.startAt,
      stipendCovered: updated.stipendCovered,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
    });
  }
  return updated;
}

// Admin REJECTS a needs-review hour log: it is NOT deleted (the coach must
// still see it + the reason) but flips to status 'rejected' so it is excluded
// from every pay/report/needs-review/accountability read (all of which pin
// status='posted'). Idempotent.
export async function rejectNeedsReviewLogInternal(
  actor: AuthedSession["user"],
  id: string,
  reason: string,
) {
  const trimmed = reason.trim();
  if (!trimmed) throw new RejectReasonRequiredError();

  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  // Idempotent — already rejected: keep the original reason/reviewer.
  if (existing.status === "rejected") return existing;

  const [updated] = await db
    .update(hourLogs)
    .set({
      status: "rejected",
      reviewedAt: new Date(),
      reviewedBy: actor.id,
      decisionReason: trimmed,
    })
    .where(eq(hourLogs.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: {
      ...(updated as unknown as Record<string, unknown>),
      reason: trimmed,
    },
  });
  return updated;
}

// 1b security B — read-only detail for the admin held-log "Details +
// edit-then-approve" view. Returns the full held log (coach + program names),
// the scheduled block it maps to (via matchLogToBlock — the ONE source of
// truth for "which block did this log belong to"), and the logged-vs-scheduled
// pay figures. Both pay figures use the log's OWN snapshot rate, so the only
// variable between them is duration. No actor — a pure read, gated at the
// public wrapper. Throws HourLogNotFoundError if the row is missing.
export type HeldLogDetail = {
  log: {
    id: string;
    coachId: string;
    coachName: string | null;
    programId: string;
    programName: string;
    startAt: Date;
    endAt: Date;
    note: string | null;
    heldReason: string | null;
    ratePer30MinCents: number | null;
    perSessionRateCents: number | null;
  };
  block: {
    id: string;
    startAt: Date;
    endAt: Date;
    coachNames: string[];
  } | null;
  loggedPayCents: number;
  scheduledPayCents: number | null;
};

export async function getHeldLogDetailInternal(
  id: string,
): Promise<HeldLogDetail> {
  const [log] = await db
    .select({
      id: hourLogs.id,
      coachId: hourLogs.coachId,
      coachName: users.name,
      programId: hourLogs.programId,
      programName: programs.name,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      note: hourLogs.note,
      heldReason: hourLogs.heldReason,
      ratePer30MinCents: hourLogs.ratePer30MinCents,
      perSessionRateCents: hourLogs.perSessionRateCents,
      status: hourLogs.status,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!log) throw new HourLogNotFoundError(id);

  // Find the matched scheduled block — same block-fetch approach as
  // logHourInternal: the coach's own blocks that overlap the log window
  // (half-open; same lt/gte). matchLogToBlock's in-set checks only read
  // `.coaches`, so the scheduled-coach fields just need to exist.
  const blockRows = await db
    .select({
      id: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    .innerJoin(
      programScheduleBlockCoaches,
      eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
    )
    .where(
      and(
        eq(programScheduleBlockCoaches.coachId, log.coachId),
        lt(programScheduleBlocks.startAt, log.endAt),
        gte(programScheduleBlocks.endAt, log.startAt),
      ),
    );
  const blocks: ReconBlock[] = blockRows.map((b) => ({
    id: b.id,
    programId: b.programId,
    scheduledCoachId: log.coachId,
    scheduledCoachName: log.coachName,
    coaches: [{ coachId: log.coachId, coachName: log.coachName ?? "" }],
    startAt: b.startAt,
    endAt: b.endAt,
  }));

  const match = matchLogToBlock(
    {
      coachId: log.coachId,
      programId: log.programId,
      startAt: log.startAt,
      endAt: log.endAt,
    },
    blocks,
  );

  // For a matched block, fetch its FULL scheduled-coach set for display (the
  // block may be shared). The matched block's program always == the log's
  // program (matchLogToBlock filters by programId), so no program lookup.
  let block: HeldLogDetail["block"] = null;
  if (match) {
    const coachRows = await db
      .select({ coachName: users.name })
      .from(programScheduleBlockCoaches)
      .innerJoin(users, eq(programScheduleBlockCoaches.coachId, users.id))
      .where(eq(programScheduleBlockCoaches.blockId, match.id));
    block = {
      id: match.id,
      startAt: match.startAt,
      endAt: match.endAt,
      coachNames: coachRows.map((c) => c.coachName ?? ""),
    };
  }

  // Pay figures off the log's OWN snapshot rate for both — the only
  // difference is the duration (logged window vs the scheduled block).
  const loggedPayCents = workPayForLog({
    perSessionRateCents: log.perSessionRateCents,
    startAt: log.startAt,
    endAt: log.endAt,
    ratePer30MinCents: log.ratePer30MinCents,
  });
  const scheduledPayCents = match
    ? workPayForLog({
        perSessionRateCents: log.perSessionRateCents,
        startAt: match.startAt,
        endAt: match.endAt,
        ratePer30MinCents: log.ratePer30MinCents,
      })
    : null;

  return {
    log: {
      id: log.id,
      coachId: log.coachId,
      coachName: log.coachName,
      programId: log.programId,
      programName: log.programName,
      startAt: log.startAt,
      endAt: log.endAt,
      note: log.note,
      heldReason: log.heldReason,
      ratePer30MinCents: log.ratePer30MinCents,
      perSessionRateCents: log.perSessionRateCents,
    },
    block,
    loggedPayCents,
    scheduledPayCents,
  };
}

// 1b security B — the admin held-approval queue, newest-first by createdAt.
// Joins the coach name (users) + program name (programs). Returns only the
// fields the queue UI renders.
export async function loadHeldHourLogs(): Promise<
  {
    id: string;
    coachName: string | null;
    programName: string;
    programId: string;
    startAt: Date;
    endAt: Date;
    heldReason: string | null;
    note: string | null;
    createdAt: Date;
  }[]
> {
  return db
    .select({
      id: hourLogs.id,
      coachName: users.name,
      programName: programs.name,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      heldReason: hourLogs.heldReason,
      note: hourLogs.note,
      createdAt: hourLogs.createdAt,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    .where(eq(hourLogs.status, "held"))
    .orderBy(desc(hourLogs.createdAt));
}

// 1b security B — held-count for the Work Log entry-point badge.
export async function countHeldHourLogs(): Promise<number> {
  const rows = await db
    .select({ id: hourLogs.id })
    .from(hourLogs)
    .where(eq(hourLogs.status, "held"));
  return rows.length;
}
