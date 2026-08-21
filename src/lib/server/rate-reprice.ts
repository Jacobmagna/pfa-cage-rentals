// SPEC rate-effective-dating §6 — the RETROACTIVE RE-PRICE ENGINE.
//
// Productizes scripts/qa/reprice-hour-logs.ts (run against prod four times
// by hand). Given a rate change with an effective date in the PAST, it
// re-prices hours that were already logged on or after that date.
//
// Outside any "use server" file, deliberately: Next.js exposes every async
// export from a "use server" file as a public RPC endpoint, and
// `applyRateReprice` takes the actor as a parameter — exposing it directly
// would let anyone forge an admin identity and rewrite payroll. The Phase-C
// wrappers gate these with requireRole("admin").
//
// ── The one design rule (SPEC §2) ────────────────────────────────────────
// Do not "bulk update rows". RE-RESOLVE each log through the SAME resolvers
// that price a fresh log, then diff. The resolvers are IMPORTED, never
// reimplemented, so a repriced log and a freshly-logged one can never
// disagree about what an hour is worth.
//
// ── Why §5 (the exclusion rule) is structural, not a filter ──────────────
// A coach holding a (coach, program) override resolves at STEP 1 of the
// precedence chain — the program default is never consulted for their logs.
// So a PROGRAM-DEFAULT retro cannot reach them, whatever date is picked.
// That falls out of re-resolution below (`resolveRateSourceKind(...) ===
// "override"` ⇒ the program default supplied nothing), NOT out of a
// `WHERE coach NOT IN (...)`: there is no coach predicate in any query in
// this file. Those coaches are then reported BY NAME so the UI can show
// Mark the rule working (SPEC §6 "he must see what it *won't* touch").
//
// ── Scope + safety ──────────────────────────────────────────────────────
//   • `startAt >= effectiveFrom` — a log dated before the effective date is
//     never re-priced.
//   • ONLY `status = 'posted'` is ever priced or written. Held logs aren't
//     payable yet; rejected logs are excluded from every money read (SPEC §6
//     guardrails). Held rows in the same window ARE read, by a separate query,
//     for a COUNT the preview reports — approving one later flips its status
//     without re-resolving its rate, so Mark is told to re-run. Nothing in
//     that count touches money.
//   • `IS DISTINCT FROM` on all three stamped columns — a log whose
//     recomputed values already match is not written at all, which is what
//     makes a second apply a true no-op (idempotence).
//   • Per-session pay is stamped FLAT, never halved like the per-30-min
//     field — the shipped bug class from migration 0052. That is guaranteed
//     here by using `resolvePerSessionRateCents` + `workPayForLog` verbatim.
//
// ── Atomicity ───────────────────────────────────────────────────────────
// neon-http is stateless HTTP and has no `db.transaction()`, but `db.batch()`
// ships all statements in a single round trip that Neon runs as ONE
// transaction. The audit inserts ride in that same batch as the UPDATEs, so
// the money and the record of what it used to be commit together or not at
// all.
//
// This is the one module that does NOT use `safeLogAudit`. Elsewhere,
// swallowing an audit failure is the right call — the data write already
// stands, and reporting it as failed would be a lie. Here the audit row's
// `before` payload is the ONLY thing that can reconstruct the prior per-log
// pay rates without a DB restore, so "money moved, record lost to a Sentry
// event" is not a failure mode worth having. Inside the batch, a failed
// audit insert rolls the pay rewrite back with it. No swallow, anywhere in
// the apply path.

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programRateOverrides,
  programs,
  users,
} from "@/db/schema";
import { buildAuditRowValues, type LogAuditInput } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import { workPayForLog } from "@/lib/billing";
import {
  ProgramNotFoundError,
  ProgramRateOverrideNotFoundError,
} from "@/lib/errors";
import {
  resolvePerSessionRateCents,
  resolveRateCentsForProgram,
  resolveRateSourceKind,
  type ProgramPayConfig,
} from "./hour-log-actions";

// ─────────────────────────────────────────────────────────────────────────
// Input contract
// ─────────────────────────────────────────────────────────────────────────

/**
 * WHICH rate changed, and therefore which logs the re-price re-resolves:
 *
 *  - `override`         a single (coach, program) override was given a past
 *                       effective date. Scope is that one coach on that one
 *                       program.
 *  - `program_default`  a program's default rate was given a past effective
 *                       date. Scope is every coach logging that program —
 *                       minus, structurally, the coaches whose logs resolve
 *                       from their own override (SPEC §5).
 */
export type RateRepriceScope =
  | { kind: "override"; coachId: string; programId: string }
  | { kind: "program_default"; programId: string };

export const rateRepriceInputSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("override"),
      coachId: z.string().min(1, "coachId is required"),
      programId: z.string().min(1, "programId is required"),
    }),
    z.object({
      kind: z.literal("program_default"),
      programId: z.string().min(1, "programId is required"),
    }),
  ]),
  // SPEC §3 decision 10.1 — past + present only. A future effective date is
  // rejected at the engine, not just hidden in the date picker, so no caller
  // (Phase C action, script, future UI) can smuggle one in.
  effectiveFrom: z.coerce
    .date()
    .refine(
      (d) => d.getTime() <= Date.now(),
      "Effective date cannot be in the future",
    ),
});

export type RateRepriceInput = z.infer<typeof rateRepriceInputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// CANDIDATE RATE — PREVIEW ONLY (SPEC §7, Phase D1)
// ─────────────────────────────────────────────────────────────────────────
//
// THE PROBLEM. The engine re-resolves from the DATABASE, so on its own the
// preview can only answer "what would re-pricing to this date do with the
// rate that is ALREADY SAVED". SPEC §7 requires the preview to appear inline
// BEFORE Save is armed — at which point the rate Mark just typed is not
// persisted yet. Without a candidate, the dialog would show him a dollar
// figure computed from the OLD rate and then write a different one. On a
// payroll path that is not an acceptable gap.
//
// THE FIX. An OPTIONAL candidate rate that substitutes for the persisted row
// in the inputs handed to the resolvers, so the preview answers "what WOULD
// this rate do". Absent → behavior is byte-identical to before.
//
// ⚠️ THREE THINGS THIS DELIBERATELY IS NOT:
//
//  1. It is NOT accepted by `applyRateReprice` — not at runtime, and not at
//     the TYPE level (see `RateRepriceApplyInput`). SPEC §6's rule that the
//     engine never trusts a caller-supplied preview is unchanged. A
//     candidate RATE feeding a read-only diff is fine; a caller-supplied
//     DIFF driving a write is the hole that stays shut. Apply keeps
//     re-reading persisted state and recomputing from scratch.
//  2. It is NOT a way around SPEC §5. A program-default candidate replaces
//     the PROGRAM's pay config and NOTHING else — never a coach's override
//     row. A coach holding an override still resolves at step 1, is still
//     unreachable, and is still reported by name.
//  3. It is NOT a way to preview a rate that could never be saved. The
//     candidate is validated with the same rules (and the same messages) as
//     the real rate schemas in @/lib/schemas — positive integer per-session
//     amounts, the same caps — and `effectiveFrom` keeps the same
//     no-future-dating refinement.

const CANDIDATE_PAY_MODE = z.enum(["hourly", "per_session"]);

/**
 * The hypothetical (coach, program) OVERRIDE row. Field-for-field the rate
 * half of `upsertProgramRateOverrideSchema`, including its messages, so a
 * candidate that this accepts is exactly a candidate that could be saved.
 */
const candidateOverrideRateSchema = z.object({
  kind: z.literal("override"),
  payMode: CANDIDATE_PAY_MODE,
  ratePer30MinCents: z
    .number()
    .int("Rate must be a whole number of cents")
    .min(1, "Rate must be greater than $0")
    .max(1_000_00, "Rate cannot exceed $1,000 per 30 minutes")
    .nullable()
    .optional(),
  perSessionRateCents: z
    .number()
    .int("Per-session amount must be a whole number of cents")
    .positive("Per-session amount must be greater than $0")
    .max(1_000_000, "Per-session amount can't exceed $10,000")
    .nullable()
    .optional(),
});

/**
 * The hypothetical PROGRAM pay config. Field-for-field the rate half of
 * `updateProgramSchema` — including that an hourly default may legitimately
 * be 0/null (an unset rate) while a per-session amount may not.
 */
const candidateProgramDefaultRateSchema = z.object({
  kind: z.literal("program_default"),
  payMode: CANDIDATE_PAY_MODE,
  defaultRatePer30MinCents: z.number().int().min(0).max(1_000_00).nullish(),
  defaultPerSessionRateCents: z
    .number()
    .int("Per-session amount must be a whole number of cents")
    .positive("Per-session amount must be greater than $0")
    .max(1_000_000, "Per-session amount can't exceed $10,000")
    .nullish(),
});

export const rateRepriceCandidateSchema = z
  .discriminatedUnion("kind", [
    candidateOverrideRateSchema,
    candidateProgramDefaultRateSchema,
  ])
  // The same cross-field rule the real schemas apply: choosing per-session
  // REQUIRES an amount, or the "preview" would quietly price everything at
  // $0. Mirrors upsertProgramRateOverrideSchema / updateProgramSchema.
  .superRefine((val, ctx) => {
    if (val.kind === "override") {
      if (val.payMode === "hourly" && val.ratePer30MinCents == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ratePer30MinCents"],
          message: "Enter an hourly rate when paying hourly",
        });
      }
      if (val.payMode === "per_session" && val.perSessionRateCents == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["perSessionRateCents"],
          message: "Enter a per-session amount when paying per session",
        });
      }
      return;
    }
    if (
      val.payMode === "per_session" &&
      val.defaultPerSessionRateCents == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultPerSessionRateCents"],
        message: "Enter a per-session amount when this program pays per session",
      });
    }
  });

export type RateRepriceCandidate = z.infer<typeof rateRepriceCandidateSchema>;

/**
 * The PREVIEW input. The apply input (`rateRepriceInputSchema`) plus the
 * optional candidate — and the schemas are related this way round on purpose:
 * preview is a strict SUPERSET of apply, so apply can never grow the field by
 * inheriting it.
 */
export const rateRepricePreviewInputSchema = rateRepriceInputSchema
  .extend({ candidateRate: rateRepriceCandidateSchema.nullish() })
  .superRefine((val, ctx) => {
    // A candidate must describe the SAME thing the retro is scoped to. This
    // is what stops an override candidate being smuggled into a
    // program-default preview, which is the only shape that could have
    // dressed up a §5-excluded coach as reachable.
    if (val.candidateRate && val.candidateRate.kind !== val.scope.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateRate", "kind"],
        message: `A ${val.candidateRate.kind} candidate rate cannot be previewed against a ${val.scope.kind} re-price`,
      });
    }
  });

export type RateRepricePreviewInput = z.infer<
  typeof rateRepricePreviewInputSchema
>;

/**
 * 🔒 THE TYPE-LEVEL LOCK on `applyRateReprice`.
 *
 * `candidateRate?: never` means no value of any type can be supplied for that
 * key — not by an object literal (excess-property check), and not by a
 * pre-built variable either, because a `RateRepriceCandidate` is not
 * assignable to `never`. So the mistake this guards against — a Phase-D
 * caller reusing the preview payload for the save — cannot compile.
 *
 * Apply also refuses one at runtime (a plain throw, since reaching it is a
 * programming error rather than a user condition), and the zod schema it
 * parses with does not carry the field at all. Three independent layers.
 */
export type RateRepriceApplyInput = {
  scope: RateRepriceScope;
  effectiveFrom: Date | string | number;
  /** Never. A caller-supplied rate must not drive a write — see above. */
  candidateRate?: never;
};

// ─────────────────────────────────────────────────────────────────────────
// Output contract
// ─────────────────────────────────────────────────────────────────────────

/** Provenance of a stamped rate. Tied to the resolver so it cannot drift. */
export type RateSourceKind = ReturnType<typeof resolveRateSourceKind>;

type ProgramRateOverrideRow = typeof programRateOverrides.$inferSelect;

/** The pay-relevant slice of an hour_logs row the engine re-resolves. */
export type RepriceLogRow = {
  id: string;
  coachId: string;
  coachName: string | null;
  coachEmail: string | null;
  programId: string;
  startAt: Date;
  endAt: Date;
  ratePer30MinCents: number | null;
  perSessionRateCents: number | null;
  rateSourceKind: RateSourceKind | null;
  /**
   * STIPEND SPEC §2.11 / §10.9 — the log's OWN record that a stipend covers it.
   * Read here so a covered log can be excluded from a re-price rather than
   * re-rated. Reading the snapshot rather than re-deriving coverage is
   * deliberate: what mattered is what was true when the log was written.
   */
  stipendCovered: boolean;
};

/** One log's before/after. Only logs that WOULD be written appear in these. */
export type RepriceLogDiff = {
  logId: string;
  coachId: string;
  coachName: string;
  programId: string;
  startAt: Date;
  endAt: Date;
  oldRatePer30MinCents: number | null;
  newRatePer30MinCents: number | null;
  oldPerSessionRateCents: number | null;
  newPerSessionRateCents: number | null;
  oldRateSourceKind: RateSourceKind | null;
  newRateSourceKind: RateSourceKind;
  oldPayCents: number;
  newPayCents: number;
  deltaCents: number;
};

/** Per-(coach, program) rollup. One UPDATE + one audit row per group. */
export type RepriceGroup = {
  coachId: string;
  coachName: string;
  programId: string;
  programName: string;
  logCount: number;
  newRatePer30MinCents: number | null;
  newPerSessionRateCents: number | null;
  newRateSourceKind: RateSourceKind;
  oldTotalPayCents: number;
  newTotalPayCents: number;
  deltaCents: number;
  logs: RepriceLogDiff[];
};

/** A coach's slice of an INCREASE / DECREASE bucket, for the confirm copy. */
export type RepriceCoachDelta = {
  coachId: string;
  coachName: string;
  logCount: number;
  oldPayCents: number;
  newPayCents: number;
  deltaCents: number;
};

export type RepriceBucket = {
  logCount: number;
  oldTotalPayCents: number;
  newTotalPayCents: number;
  totalDeltaCents: number;
  logs: RepriceLogDiff[];
  byCoach: RepriceCoachDelta[];
};

/**
 * A coach the retro CANNOT reach (SPEC §5). Not filtered out — re-resolved,
 * found to resolve from their own override, and reported by name.
 */
export type RepriceExcludedCoach = {
  coachId: string;
  coachName: string;
  logCount: number;
  /**
   * `resolves_from_own_override` — SPEC §5: the coach's own override supplied
   * the rate, so a program-default change cannot reach them.
   *
   * 🔴 `covered_by_stipend` — STIPEND SPEC §10.9: the log is paid by the
   * coach's half-month stipend and carries NO rate. Re-pricing it would stamp
   * a real hourly rate onto work the stipend already paid for, i.e. pay it
   * twice. Excluded and REPORTED, never silently skipped: a preview that
   * omitted these would tell Mark a stipend coach's pay is changing when it
   * must not.
   *
   * ⚠️ One entry per coach, first reason wins. A coach with BOTH kinds (a
   * stipend that began mid-window) reports as `covered_by_stipend` since that
   * check runs first, while `logCount` still counts all their excluded logs.
   */
  reason: "resolves_from_own_override" | "covered_by_stipend";
};

export type RateRepricePreview = {
  scope: RateRepriceScope;
  effectiveFrom: Date;
  /**
   * The hypothetical rate this diff was computed against, or null when it was
   * computed against what is persisted. Carried on the output so a consumer
   * (and a test) can always tell WHICH question the numbers answer — an
   * `applyRateReprice` result is always null here, because apply re-reads.
   */
  candidateRate: RateRepriceCandidate | null;
  programId: string;
  programName: string;
  /** Posted logs on/after effectiveFrom that were re-resolved. */
  scannedLogCount: number;
  /** In-scope + re-resolved to the exact same stamps → not written. */
  unchangedLogCount: number;
  /** Reached by §5 exclusion: resolved from the coach's own override. */
  excludedLogCount: number;
  /** Rows that will be WRITTEN. Includes provenance-only rows (see below). */
  changedLogCount: number;
  /**
   * 🔴 THE NUMBER MARK CONFIRMS. The subset of `logs` whose PAY actually
   * moves.
   *
   * `changedLogCount` counts rows that get an UPDATE, and that is deliberately
   * wider: `rate_source_kind` shipped nullable with no backfill, so on the
   * first production run EVERY pre-existing row has a NULL provenance, the
   * `isDistinct` check fires on provenance alone, and every in-window log
   * lands in `changed` with `deltaCents = 0`. Those rows must still be
   * written — provenance has to stop lying — but a confirm screen that says
   * "re-pricing 214 entries" when 6 move money is not a number anyone can
   * sanely confirm.
   *
   * The delta is identical either way (a provenance-only row moves $0), which
   * is why this changes no dollar the engine computes: `payChanged
   * .totalDeltaCents === totalDeltaCents`, always.
   */
  payChanged: RepriceBucket;
  /**
   * Rows written for PROVENANCE ONLY — both rate columns already correct,
   * `rate_source_kind` alone moved. Reported separately so the first prod run
   * can say what it is doing without inflating the headline.
   */
  provenanceOnlyLogCount: number;
  /**
   * SPEC §6 guardrail, made VISIBLE. Held logs in the same scope + window are
   * correctly skipped — they are not payable yet — but approving one later
   * only flips its status; it does not re-resolve the rate, so it posts at its
   * original (usually $0) stamp. Counting them here lets the preview say
   * "re-run this after approving them" instead of leaving a silent trap.
   *
   * INFORMATIONAL ONLY. Nothing in the write path reads it, and no dollar
   * depends on it.
   */
  heldLogCount: number;
  logs: RepriceLogDiff[];
  groups: RepriceGroup[];
  increases: RepriceBucket;
  decreases: RepriceBucket;
  excludedCoaches: RepriceExcludedCoach[];
  oldTotalPayCents: number;
  newTotalPayCents: number;
  totalDeltaCents: number;
};

export type RateRepriceResult = {
  preview: RateRepricePreview;
  appliedLogCount: number;
  appliedGroupCount: number;
  auditEntityIds: string[];
};

// ─────────────────────────────────────────────────────────────────────────
// The pure diff — no DB, no clock, no I/O
// ─────────────────────────────────────────────────────────────────────────

function displayName(log: RepriceLogRow): string {
  return log.coachName ?? log.coachEmail ?? log.coachId;
}

function emptyBucket(): RepriceBucket {
  return {
    logCount: 0,
    oldTotalPayCents: 0,
    newTotalPayCents: 0,
    totalDeltaCents: 0,
    logs: [],
    byCoach: [],
  };
}

function buildBucket(logs: RepriceLogDiff[]): RepriceBucket {
  const byCoach = new Map<string, RepriceCoachDelta>();
  let oldTotalPayCents = 0;
  let newTotalPayCents = 0;
  for (const l of logs) {
    oldTotalPayCents += l.oldPayCents;
    newTotalPayCents += l.newPayCents;
    const entry = byCoach.get(l.coachId) ?? {
      coachId: l.coachId,
      coachName: l.coachName,
      logCount: 0,
      oldPayCents: 0,
      newPayCents: 0,
      deltaCents: 0,
    };
    entry.logCount += 1;
    entry.oldPayCents += l.oldPayCents;
    entry.newPayCents += l.newPayCents;
    entry.deltaCents += l.deltaCents;
    byCoach.set(l.coachId, entry);
  }
  return {
    logCount: logs.length,
    oldTotalPayCents,
    newTotalPayCents,
    totalDeltaCents: newTotalPayCents - oldTotalPayCents,
    logs,
    byCoach: [...byCoach.values()].sort(
      (a, b) =>
        Math.abs(b.deltaCents) - Math.abs(a.deltaCents) ||
        a.coachName.localeCompare(b.coachName),
    ),
  };
}

/**
 * THE ENGINE. Pure: given the program's pay config, every override on that
 * program, and the candidate logs, produce the full diff. Every DB concern
 * (which rows to load, how to write them) lives in the two callers below, so
 * the whole (override × program × per-session) branch space is unit-testable
 * without a database.
 *
 * `logs` MUST already be narrowed to `status = 'posted'` and
 * `startAt >= effectiveFrom` by the loader; both are re-asserted here so a
 * future caller cannot widen the blast radius by accident.
 *
 * `candidateRate` (PREVIEW ONLY — apply cannot supply one) substitutes a
 * hypothetical rate for the persisted one. It is applied ONCE, up front, to
 * the two inputs the resolvers read — never inside the loop, and never as a
 * branch in the pricing itself. Everything below the substitution runs the
 * identical code path whether a candidate was supplied or not, which is the
 * property that makes a candidate preview trustworthy: it is the same engine,
 * fed different rows.
 */
export function computeRateRepriceDiff(args: {
  scope: RateRepriceScope;
  effectiveFrom: Date;
  program: ProgramPayConfig & { id: string; name: string };
  /** EVERY override on this program — including coaches the retro can't reach. */
  overrides: ProgramRateOverrideRow[];
  logs: RepriceLogRow[];
  /**
   * HELD logs in the same scope + window, for the informational count only
   * (SPEC §6 — held logs are never re-priced). Kept as a SEPARATE parameter
   * from `logs`, not a status field on one array, so no future edit to the
   * loop below can accidentally price one: nothing in this function reads
   * anything off these rows except which of them are in scope.
   */
  heldLogs?: RepriceLogRow[];
  /** SPEC §7 — the not-yet-saved rate to answer "what WOULD this do". */
  candidateRate?: RateRepriceCandidate | null;
}): RateRepricePreview {
  const { scope, effectiveFrom } = args;
  const candidateRate = args.candidateRate ?? null;

  // A candidate that describes a different thing than the retro is scoped to
  // is incoherent, not merely ignorable — the preview would silently answer a
  // question nobody asked. `rateRepricePreviewInputSchema` already rejects it;
  // this is the same rule restated for direct callers of the pure function.
  if (candidateRate && candidateRate.kind !== scope.kind) {
    throw new Error(
      `computeRateRepriceDiff: a "${candidateRate.kind}" candidate rate cannot be applied to a "${scope.kind}" re-price`,
    );
  }

  // ── SUBSTITUTION 1: the PROGRAM pay config. ──
  // Only for a program_default candidate, and only the three pay fields the
  // resolvers read. `overrides` is untouched here, which is precisely why
  // SPEC §5 survives: an override coach still resolves at step 1 against her
  // OWN row, so a hypothetical program default cannot reach her either.
  const program: ProgramPayConfig & { id: string; name: string } =
    candidateRate?.kind === "program_default"
      ? {
          ...args.program,
          payMode: candidateRate.payMode,
          defaultRatePer30MinCents:
            candidateRate.defaultRatePer30MinCents ?? null,
          defaultPerSessionRateCents:
            candidateRate.defaultPerSessionRateCents ?? null,
        }
      : args.program;

  const overrideByCoach = new Map<string, ProgramRateOverrideRow>(
    args.overrides
      .filter((o) => o.programId === program.id)
      .map((o) => [o.coachId, o]),
  );

  // ── SUBSTITUTION 2: the (coach, program) OVERRIDE row. ──
  // Only for an override candidate, and only for THE ONE COACH the retro is
  // scoped to. No other coach's override is replaced, invented or removed.
  // The persisted row is spread first so the non-pay columns keep real values
  // (nothing reads them, but a half-built row is a trap for the next reader);
  // when there is no persisted row, the candidate IS the hypothetical row —
  // that is the first-time-override case the inline preview exists for.
  if (candidateRate?.kind === "override" && scope.kind === "override") {
    const persisted = overrideByCoach.get(scope.coachId);
    overrideByCoach.set(scope.coachId, {
      ...(persisted ?? {
        effectiveFrom: null,
        updatedAt: new Date(0),
      }),
      coachId: scope.coachId,
      programId: program.id,
      payMode: candidateRate.payMode,
      ratePer30MinCents: candidateRate.ratePer30MinCents ?? null,
      perSessionRateCents: candidateRate.perSessionRateCents ?? null,
    });
  }

  const changed: RepriceLogDiff[] = [];
  const excludedByCoach = new Map<string, RepriceExcludedCoach>();
  let scannedLogCount = 0;
  let unchangedLogCount = 0;
  let excludedLogCount = 0;

  for (const log of args.logs) {
    // Defense in depth — the loader already scopes on all three.
    if (log.programId !== program.id) continue;
    if (log.startAt.getTime() < effectiveFrom.getTime()) continue;
    // The `override` scope IS a single (coach, program) pair; other coaches'
    // logs are simply not in scope (they are not "excluded" — nothing about
    // this rate change concerns them).
    if (scope.kind === "override" && log.coachId !== scope.coachId) continue;

    // 🔴 STIPEND SPEC §10.9 — BEFORE any re-resolution. This module was
    // originally scoped as "no change: a stipend has no hour_logs snapshot",
    // which was wrong in the most dangerous way: it does not READ stipends, but
    // it WRITES the very rate snapshots that make a covered log $0. Left alone,
    // Mark running a retro rate change on a program would silently un-zero
    // every covered log and pay it hourly ON TOP of the stipend.
    //
    // Excluded and REPORTED, never quietly skipped.
    if (log.stipendCovered) {
      excludedLogCount += 1;
      const covered = excludedByCoach.get(log.coachId) ?? {
        coachId: log.coachId,
        coachName: displayName(log),
        logCount: 0,
        reason: "covered_by_stipend" as const,
      };
      covered.logCount += 1;
      excludedByCoach.set(log.coachId, covered);
      continue;
    }

    // ── RE-RESOLUTION. The identical precedence chain logHourInternal runs
    // for a brand-new log, with this log's own (coach, program) rows. ──
    const override = overrideByCoach.get(log.coachId) ?? null;
    // `log.stipendCovered` is false on every row that reaches here (the guard
    // above returned), but it is passed EXPLICITLY rather than as a literal
    // `false`: the value stays correct if that guard is ever moved, and the
    // call site keeps saying which log it is talking about.
    const newRatePer30MinCents = resolveRateCentsForProgram(
      override,
      program,
      log.stipendCovered,
    );
    const newPerSessionRateCents = resolvePerSessionRateCents(
      override,
      program,
      log.stipendCovered,
    );
    const newRateSourceKind = resolveRateSourceKind(
      override,
      program,
      log.stipendCovered,
    );

    // ── SPEC §5, structurally. This is not a coach blocklist: we asked the
    // resolvers who supplied this log's rate. "override" means the chain
    // short-circuited at step 1 and the PROGRAM DEFAULT WAS NEVER CONSULTED
    // — so a change to the program default cannot, by construction, be this
    // log's rate. Report the coach and move on; their logs are fixed by
    // running the retro on THEIR override instead (SPEC §5, two tools, no
    // overlap, no double-application).
    if (scope.kind === "program_default" && newRateSourceKind === "override") {
      excludedLogCount += 1;
      const entry = excludedByCoach.get(log.coachId) ?? {
        coachId: log.coachId,
        coachName: displayName(log),
        logCount: 0,
        reason: "resolves_from_own_override" as const,
      };
      entry.logCount += 1;
      excludedByCoach.set(log.coachId, entry);
      continue;
    }

    scannedLogCount += 1;

    // IS DISTINCT FROM, in TS. All three stamped columns — a provenance-only
    // change still has to be written so rateSourceKind stops lying.
    const isDistinct =
      newRatePer30MinCents !== log.ratePer30MinCents ||
      newPerSessionRateCents !== log.perSessionRateCents ||
      newRateSourceKind !== log.rateSourceKind;
    if (!isDistinct) {
      unchangedLogCount += 1;
      continue;
    }

    // Pay via the single read-path helper, so a per-session log is valued at
    // its FLAT amount and an hourly log by exact duration — the engine never
    // does money arithmetic of its own.
    const oldPayCents = workPayForLog({
      perSessionRateCents: log.perSessionRateCents,
      startAt: log.startAt,
      endAt: log.endAt,
      ratePer30MinCents: log.ratePer30MinCents,
    });
    const newPayCents = workPayForLog({
      perSessionRateCents: newPerSessionRateCents,
      startAt: log.startAt,
      endAt: log.endAt,
      ratePer30MinCents: newRatePer30MinCents,
    });

    changed.push({
      logId: log.id,
      coachId: log.coachId,
      coachName: displayName(log),
      programId: log.programId,
      startAt: log.startAt,
      endAt: log.endAt,
      oldRatePer30MinCents: log.ratePer30MinCents,
      newRatePer30MinCents,
      oldPerSessionRateCents: log.perSessionRateCents,
      newPerSessionRateCents,
      oldRateSourceKind: log.rateSourceKind,
      newRateSourceKind,
      oldPayCents,
      newPayCents,
      deltaCents: newPayCents - oldPayCents,
    });
  }

  changed.sort(
    (a, b) =>
      a.coachName.localeCompare(b.coachName) ||
      a.startAt.getTime() - b.startAt.getTime() ||
      a.logId.localeCompare(b.logId),
  );

  // Per-(coach, program) rollup. Every log in a group re-resolves to the
  // SAME three values (resolution depends only on the pair), which is what
  // makes one UPDATE + one audit row per group correct.
  const groupMap = new Map<string, RepriceGroup>();
  for (const l of changed) {
    const key = groupKey(l.coachId, l.programId);
    const group = groupMap.get(key) ?? {
      coachId: l.coachId,
      coachName: l.coachName,
      programId: l.programId,
      programName: program.name,
      logCount: 0,
      newRatePer30MinCents: l.newRatePer30MinCents,
      newPerSessionRateCents: l.newPerSessionRateCents,
      newRateSourceKind: l.newRateSourceKind,
      oldTotalPayCents: 0,
      newTotalPayCents: 0,
      deltaCents: 0,
      logs: [],
    };
    group.logCount += 1;
    group.oldTotalPayCents += l.oldPayCents;
    group.newTotalPayCents += l.newPayCents;
    group.deltaCents += l.deltaCents;
    group.logs.push(l);
    groupMap.set(key, group);
  }
  const groups = [...groupMap.values()].sort(
    (a, b) => a.coachName.localeCompare(b.coachName) || (a.deltaCents - b.deltaCents),
  );

  const oldTotalPayCents = changed.reduce((a, l) => a + l.oldPayCents, 0);
  const newTotalPayCents = changed.reduce((a, l) => a + l.newPayCents, 0);

  // A row is PROVENANCE-ONLY when both stamped rate columns already match and
  // the only thing `isDistinct` caught was `rate_source_kind`. That is the
  // whole of the un-backfilled-column case: pay cannot move when neither rate
  // column moves.
  const provenanceOnlyLogCount = changed.filter(
    (l) =>
      l.oldRatePer30MinCents === l.newRatePer30MinCents &&
      l.oldPerSessionRateCents === l.newPerSessionRateCents,
  ).length;

  // ── HELD (SPEC §6, informational). The same scope + window narrowing the
  // loop above applies, INCLUDING the §5 exclusion: a held log belonging to a
  // coach who resolves from her own override would not be re-priced by a
  // program-default retro even after approval, so nudging Mark to re-run for
  // it would be a false alarm. No pay is read, computed or written here.
  let heldLogCount = 0;
  for (const log of args.heldLogs ?? []) {
    if (log.programId !== program.id) continue;
    if (log.startAt.getTime() < effectiveFrom.getTime()) continue;
    if (scope.kind === "override" && log.coachId !== scope.coachId) continue;
    // A covered held log would not be re-priced after approval either, so
    // counting it here would nudge Mark to re-run for something that can never
    // move — the same false-alarm reasoning as the §5 exclusion below.
    if (log.stipendCovered) continue;
    if (
      scope.kind === "program_default" &&
      resolveRateSourceKind(
        overrideByCoach.get(log.coachId) ?? null,
        program,
        log.stipendCovered,
      ) === "override"
    ) {
      continue;
    }
    heldLogCount += 1;
  }

  return {
    scope,
    effectiveFrom,
    candidateRate,
    programId: program.id,
    programName: program.name,
    scannedLogCount,
    unchangedLogCount,
    excludedLogCount,
    changedLogCount: changed.length,
    // The headline set: rows whose PAY moves. Same delta as the whole set by
    // construction — every row it drops has deltaCents === 0.
    payChanged: bucketOrEmpty(changed.filter((l) => l.deltaCents !== 0)),
    provenanceOnlyLogCount,
    heldLogCount,
    logs: changed,
    groups,
    // 🔴 SPEC §6 — decreases get their own bucket because the app has no
    // payout ledger: Mark pays coaches outside the system, so a decrease can
    // retroactively "un-pay" money already handed over. byCoach names who
    // loses what.
    increases: bucketOrEmpty(changed.filter((l) => l.deltaCents > 0)),
    decreases: bucketOrEmpty(changed.filter((l) => l.deltaCents < 0)),
    excludedCoaches: [...excludedByCoach.values()].sort(
      (a, b) => a.coachName.localeCompare(b.coachName),
    ),
    oldTotalPayCents,
    newTotalPayCents,
    totalDeltaCents: newTotalPayCents - oldTotalPayCents,
  };
}

function bucketOrEmpty(logs: RepriceLogDiff[]): RepriceBucket {
  return logs.length === 0 ? emptyBucket() : buildBucket(logs);
}

/** Composite audit entity id — matches what the proven QA script wrote to prod. */
function groupKey(coachId: string, programId: string): string {
  return `${coachId}::${programId}`;
}

/**
 * The audit payload for one re-priced (coach, program) group. Pure, and
 * exported so a test can prove the row it produces is byte-identical to what
 * `logAudit` writes — the two writers must never drift, or `audit_log.diff`
 * means different things depending on which path wrote it.
 *
 * `before.logs` is the reversibility record: every log's id, window, old rate
 * snapshots, old provenance and old pay. That is enough to reconstruct the
 * prior state without a DB restore, which is exactly why this insert belongs
 * inside the same transaction as the money.
 */
export function buildRepriceAuditInput(args: {
  actorId: string;
  scope: RateRepriceScope;
  effectiveFrom: Date;
  group: RepriceGroup;
}): LogAuditInput {
  const { group } = args;
  return {
    actorUserId: args.actorId,
    entityType: "hour_log_reprice",
    entityId: groupKey(group.coachId, group.programId),
    action: "update",
    // 🔴 NOT shallow-diffed. `before`/`after` here are a REPORT of one
    // (coach, program) group, not two snapshots of a row, so dropping keys
    // that are equal on both sides deletes information rather than noise —
    // most visibly `totalPayCents` on a NET-ZERO group, the one case where a
    // reader most needs the group total spelled out. Reversibility was never
    // at risk (the per-log array always differs and always survived); this
    // makes the record complete.
    diffMode: "full",
    before: {
      totalPayCents: group.oldTotalPayCents,
      logs: group.logs.map((l) => ({
        id: l.logId,
        startAt: l.startAt.toISOString(),
        endAt: l.endAt.toISOString(),
        ratePer30MinCents: l.oldRatePer30MinCents,
        perSessionRateCents: l.oldPerSessionRateCents,
        rateSourceKind: l.oldRateSourceKind,
        payCents: l.oldPayCents,
      })),
    },
    after: {
      reason:
        "Retroactive re-price: a rate was given an effective date in the past (SPEC rate-effective-dating §6).",
      scope: args.scope,
      effectiveFrom: args.effectiveFrom.toISOString(),
      coachId: group.coachId,
      programId: group.programId,
      programName: group.programName,
      ratePer30MinCents: group.newRatePer30MinCents,
      perSessionRateCents: group.newPerSessionRateCents,
      rateSourceKind: group.newRateSourceKind,
      totalPayCents: group.newTotalPayCents,
      deltaCents: group.deltaCents,
      logs: group.logs.map((l) => ({
        id: l.logId,
        ratePer30MinCents: l.newRatePer30MinCents,
        perSessionRateCents: l.newPerSessionRateCents,
        rateSourceKind: l.newRateSourceKind,
        payCents: l.newPayCents,
      })),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The read side (shared by preview AND apply)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Loads everything the diff needs. SELECTs only — this function, and every
 * statement in it, is read-only, which is what makes `previewRateReprice`
 * provably write-free.
 *
 * NOTE what is NOT in the WHERE clause: any predicate on coach. Every posted
 * log on the program in the window is loaded and re-resolved, including the
 * coaches §5 excludes — the exclusion is decided by re-resolution in
 * computeRateRepriceDiff, never by narrowing the query.
 */
async function loadRepriceInputs(
  scope: RateRepriceScope,
  effectiveFrom: Date,
  /**
   * PREVIEW-ONLY relaxation. An override-scoped retro normally REQUIRES the
   * override row to exist (see below). With a candidate override supplied,
   * the candidate IS the row — and the whole point of the inline preview is
   * that it runs BEFORE the row is written, including the very first time a
   * coach gets an override. Never passed by `applyRateReprice`, which has no
   * candidate and so keeps demanding a persisted row.
   */
  candidateSuppliesOverride = false,
) {
  const [program] = await db
    .select({
      id: programs.id,
      name: programs.name,
      payMode: programs.payMode,
      defaultRatePer30MinCents: programs.defaultRatePer30MinCents,
      defaultPerSessionRateCents: programs.defaultPerSessionRateCents,
      stipendEligible: programs.stipendEligible,
    })
    .from(programs)
    .where(eq(programs.id, scope.programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(scope.programId);

  const overrides = await db
    .select()
    .from(programRateOverrides)
    .where(eq(programRateOverrides.programId, scope.programId));

  // An override-scoped retro with no override row is a caller bug: there is
  // no override rate to apply, and silently falling through to the program
  // default would re-price a coach from a rate change that isn't theirs.
  if (
    scope.kind === "override" &&
    !candidateSuppliesOverride &&
    !overrides.some((o) => o.coachId === scope.coachId)
  ) {
    throw new ProgramRateOverrideNotFoundError(scope.coachId, scope.programId);
  }

  const selectLogsWithStatus = (status: "posted" | "held") =>
    db
      .select({
        id: hourLogs.id,
        coachId: hourLogs.coachId,
        coachName: users.name,
        coachEmail: users.email,
        programId: hourLogs.programId,
        startAt: hourLogs.startAt,
        endAt: hourLogs.endAt,
        ratePer30MinCents: hourLogs.ratePer30MinCents,
        perSessionRateCents: hourLogs.perSessionRateCents,
        rateSourceKind: hourLogs.rateSourceKind,
        stipendCovered: hourLogs.stipendCovered,
      })
      .from(hourLogs)
      .innerJoin(users, eq(users.id, hourLogs.coachId))
      .where(
        and(
          eq(hourLogs.programId, scope.programId),
          eq(hourLogs.status, status),
          // SPEC §6.1: never re-price a log dated before the effective date.
          gte(hourLogs.startAt, effectiveFrom),
        ),
      );

  // SPEC §6 guardrail: held logs aren't payable yet, rejected logs are
  // excluded from every money read. ONLY POSTED MONEY MOVES — `logs` is the
  // only array the diff prices, and it is `status = 'posted'` exactly as
  // before.
  const logs: RepriceLogRow[] = await selectLogsWithStatus("posted");

  // A SECOND, separate read for the informational held count. Held rows never
  // enter `logs`, so they cannot be re-priced by accident; they exist here so
  // the preview can tell Mark that approving one later will post it at its
  // ORIGINAL stamp (approval flips status, it does not re-resolve the rate).
  const heldLogs: RepriceLogRow[] = await selectLogsWithStatus("held");

  return { program, overrides, logs, heldLogs };
}

// ─────────────────────────────────────────────────────────────────────────
// PREVIEW — read-only, zero writes
// ─────────────────────────────────────────────────────────────────────────

/**
 * SPEC §6 "preview before commit". Returns the full diff and writes NOTHING:
 * the only DB calls it makes are the three SELECTs in `loadRepriceInputs`,
 * and everything after that is the pure function above.
 *
 * SPEC §7 (Phase D1) — accepts an OPTIONAL `candidateRate`, the rate the admin
 * has typed but not yet saved, so the inline preview can show the real dollar
 * figure for the rate that is about to be written rather than for the one
 * currently on the row. Omit it and this is byte-identical to before.
 *
 * Adding a candidate does not add a write: the substitution happens entirely
 * in memory, in the rows handed to the resolvers. The DB statements below are
 * the same three SELECTs either way.
 *
 * No actor parameter, unlike the mutating half — there is no privileged
 * identity to forge in a function that cannot change anything. The Phase-C
 * "use server" wrapper still gates it with requireRole("admin"); this file is
 * never itself an RPC surface.
 */
export async function previewRateReprice(
  input: unknown,
): Promise<RateRepricePreview> {
  const parsed = rateRepricePreviewInputSchema.parse(input);
  const candidateRate = parsed.candidateRate ?? null;
  const { program, overrides, logs, heldLogs } = await loadRepriceInputs(
    parsed.scope,
    parsed.effectiveFrom,
    candidateRate?.kind === "override",
  );
  return computeRateRepriceDiff({
    scope: parsed.scope,
    effectiveFrom: parsed.effectiveFrom,
    program,
    overrides,
    logs,
    heldLogs,
    candidateRate,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// APPLY — atomic
// ─────────────────────────────────────────────────────────────────────────

/**
 * Re-prices for real. Deliberately takes NO caller-supplied preview: it
 * re-loads and re-computes everything from scratch, so a stale or hostile
 * client cannot hand over a doctored diff and have it written. The preview
 * it returns is the one it actually applied.
 *
 * Writes are ONE `db.batch` — a single Neon transaction carrying both the
 * UPDATEs and the audit inserts. All of it commits or none of it does.
 *
 * That pairing is deliberate and is the one place this module departs from
 * the `safeLogAudit` convention used by every other mutation here. Elsewhere,
 * swallowing an audit failure is right: the data write already stands and
 * refusing it would be a lie. Here the audit row's `before` payload is the
 * ONLY record able to reconstruct the prior per-log pay rates without a DB
 * restore — so money moving while that record is lost to a Sentry event is
 * not an acceptable outcome. Inside the batch, a failed audit insert rolls
 * the money back instead. There is no swallow anywhere in this path.
 *
 * Each UPDATE is additionally guarded by `IS DISTINCT FROM` at the SQL layer
 * as well as in the diff, so a row that changed underneath us between load
 * and write is left alone rather than clobbered.
 *
 * 🔒 AND IT TAKES NO CANDIDATE RATE (SPEC §7 / Phase D1). The preview may be
 * asked "what WOULD this unsaved rate do"; the write may only ever be told
 * "re-resolve what is saved". `RateRepriceApplyInput` makes that a COMPILE
 * error via `candidateRate?: never`, `rateRepriceInputSchema` does not carry
 * the field, and the runtime check below refuses one outright rather than
 * ignoring it — silently dropping it would mean writing a number other than
 * the one that was previewed.
 */
export async function applyRateReprice(
  actor: AuthedSession["user"],
  input: RateRepriceApplyInput,
): Promise<RateRepriceResult> {
  // Belt-and-braces behind the type-level lock: `input` reaches here as
  // `unknown` from any JS caller (a "use server" boundary erases types), so
  // the invariant is also enforced at runtime. Loud, not silent — see above.
  if (
    typeof input === "object" &&
    input !== null &&
    "candidateRate" in input &&
    (input as { candidateRate?: unknown }).candidateRate != null
  ) {
    throw new Error(
      "applyRateReprice does not accept a candidate rate: the write re-resolves " +
        "from persisted state only (SPEC rate-effective-dating §6). Persist the " +
        "rate first, then apply.",
    );
  }

  const parsed = rateRepriceInputSchema.parse(input);

  const { program, overrides, logs, heldLogs } = await loadRepriceInputs(
    parsed.scope,
    parsed.effectiveFrom,
  );
  const preview = computeRateRepriceDiff({
    scope: parsed.scope,
    effectiveFrom: parsed.effectiveFrom,
    program,
    overrides,
    logs,
    heldLogs,
  });

  // Nothing to do — the idempotent case. No UPDATE, no audit row, no lie in
  // the trail about a change that didn't happen.
  if (preview.groups.length === 0) {
    return {
      preview,
      appliedLogCount: 0,
      appliedGroupCount: 0,
      auditEntityIds: [],
    };
  }

  const statements = preview.groups.map((group) =>
    db
      .update(hourLogs)
      .set({
        ratePer30MinCents: group.newRatePer30MinCents,
        perSessionRateCents: group.newPerSessionRateCents,
        rateSourceKind: group.newRateSourceKind,
      })
      .where(
        and(
          // Exactly the rows the diff decided on — nothing wider.
          inArray(
            hourLogs.id,
            group.logs.map((l) => l.logId),
          ),
          // Re-asserted at the SQL layer: a log that got held/rejected or was
          // otherwise moved since the load must not be re-priced.
          eq(hourLogs.status, "posted"),
          gte(hourLogs.startAt, parsed.effectiveFrom),
          // SPEC §6.3 — IS DISTINCT FROM. A row already carrying these values
          // is not written (NULL-safe, which `<>` is not).
          sql`(${hourLogs.ratePer30MinCents} IS DISTINCT FROM ${group.newRatePer30MinCents}
            OR ${hourLogs.perSessionRateCents} IS DISTINCT FROM ${group.newPerSessionRateCents}
            OR ${hourLogs.rateSourceKind} IS DISTINCT FROM ${group.newRateSourceKind})`,
        ),
      ),
  );

  // One audit row per (coach, program) group, carrying EVERY old per-log rate
  // and pay — enough to reconstruct the prior state without a DB restore.
  // Built through `buildAuditRowValues` (the same function `logAudit` calls)
  // so the row shape is byte-identical to every other writer's, then APPENDED
  // TO THE SAME BATCH as the UPDATEs above. Not a follow-up statement, not
  // swallowed: if the audit insert fails, the pay rewrite fails with it.
  const auditEntityIds: string[] = [];
  for (const group of preview.groups) {
    auditEntityIds.push(groupKey(group.coachId, group.programId));
    statements.push(
      db
        .insert(auditLog)
        .values(
          buildAuditRowValues(
            buildRepriceAuditInput({
              actorId: actor.id,
              scope: parsed.scope,
              effectiveFrom: parsed.effectiveFrom,
              group,
            }),
          ),
        ) as unknown as (typeof statements)[number],
    );
  }

  // drizzle types batch() as a non-empty TUPLE; we build a runtime array and
  // have already returned early when it is empty. Same pattern as the proven
  // QA script (which used @ts-expect-error) — narrowed here instead of muted.
  type BatchStatements = Parameters<typeof db.batch>[0];
  await db.batch(statements as unknown as BatchStatements);

  return {
    preview,
    appliedLogCount: preview.changedLogCount,
    appliedGroupCount: preview.groups.length,
    auditEntityIds,
  };
}
