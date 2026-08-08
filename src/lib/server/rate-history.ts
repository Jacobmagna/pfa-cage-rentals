// SPEC rate-effective-dating §7 — the RATE HISTORY behind the 3-dot menu.
//
// Jacob's UI call: the history does not belong on the row (it would be
// clutter on a surface Mark reads every week), it belongs one click away. So
// the menu fetches on open, and this is what it fetches.
//
// ── Read-only, and outside any "use server" file ─────────────────────────
// Same rule as the rest of this feature: Next.js turns every async export of
// a "use server" module into a public RPC endpoint, so the requireRole("admin")
// wrappers live in the two route action files and this module is imported by
// them. Nothing here writes; every statement is a SELECT.
//
// ── Where the history actually comes from ────────────────────────────────
// There is no rate-period table — SPEC §3 collapsed the design to two additive
// `effective_from` columns precisely to avoid one. So a "period list" is
// RECONSTRUCTED from the append-only audit trail that already existed:
//
//   • entityType "program_rate_override", entityId "<coachId>:<programId>"
//     — the per-coach override. `diff.after` is the FULL row (the upsert path
//     passes whole snapshots), so payMode, both rate columns and effectiveFrom
//     are all present.
//   • entityType "program", entityId "<programId>" — the program default.
//     ⚠️ This one logs a SHALLOW DIFF (changed keys only, see src/lib/audit.ts),
//     so `diff.after` may be missing rate keys on a change that only renamed
//     the program. Those rows are dropped rather than rendered as "rate
//     changed to nothing" — a history that invents a rate change is worse than
//     one that omits a rename.
//   • entityType "hour_log_reprice", entityId "<coachId>::<programId>" — the
//     retro itself, written by the engine, one row per (coach, program) group.
//     Attached to the rate change that caused it, so the menu can say not just
//     "the rate changed" but "…and it moved 14 already-logged entries".
//
// ── How a re-price is matched to its rate change ─────────────────────────
// The rule lives in @/lib/rate-history-match (a plain module, so it is unit
// testable — this one imports @/db). Same effectiveFrom, ts at or after the
// rate change, inside a 5-minute window, ONE row per (coach, program) group so
// a double submit cannot inflate the count. That is presentation only — if a
// match is ever missed the history simply omits the "…and N entries were
// re-priced" sub-line; no number changes.

import { and, desc, eq, inArray, like } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, programRateOverrides, programs, users } from "@/db/schema";
import { formatRateLabel } from "@/lib/rate-reprice-copy";
import { matchReprice, type RepriceAudit } from "@/lib/rate-history-match";

export type RateHistoryEntry = {
  /** The audit row id — stable React key. */
  id: string;
  /** "$30.00 / hr" · "$100.00 / session" · "No rate set". */
  rateLabel: string;
  /** What the rate applied from, or null for "going forward only". */
  effectiveFrom: Date | null;
  /** When it was saved. */
  setAt: Date;
  /** Who saved it — display name, else email, else "—". */
  actor: string;
  /** True for the row that REMOVED the override (there is no rate after it). */
  removed: boolean;
  /**
   * The retro that rode along with this save, if any. Presentation only —
   * see the header on how it is matched.
   */
  reprice: { logCount: number; deltaCents: number } | null;
};

export type RateHistory = {
  /** The rate live on the row right now, for the menu's header. */
  current: { rateLabel: string; effectiveFrom: Date | null } | null;
  /** Newest first. */
  entries: RateHistoryEntry[];
};

type RateSnapshot = {
  payMode?: unknown;
  ratePer30MinCents?: unknown;
  perSessionRateCents?: unknown;
  defaultRatePer30MinCents?: unknown;
  defaultPerSessionRateCents?: unknown;
  effectiveFrom?: unknown;
  defaultRateEffectiveFrom?: unknown;
};

type AuditDiff = { before?: RateSnapshot | null; after?: RateSnapshot | null };

function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function asPayMode(v: unknown): "hourly" | "per_session" {
  return v === "per_session" ? "per_session" : "hourly";
}

/**
 * One re-price audit row, reduced to the two numbers the menu shows.
 * `after.logs` is the per-log array the engine writes; its length is the
 * authoritative count for that (coach, program) group.
 */
function parseRepriceRow(
  entityId: string,
  diff: unknown,
  ts: Date,
): RepriceAudit | null {
  if (!diff || typeof diff !== "object") return null;
  const after = (diff as { after?: unknown }).after;
  if (!after || typeof after !== "object") return null;
  const a = after as {
    effectiveFrom?: unknown;
    deltaCents?: unknown;
    logs?: unknown;
  };
  return {
    entityId,
    effectiveFromIso:
      typeof a.effectiveFrom === "string" ? a.effectiveFrom : null,
    ts,
    logCount: Array.isArray(a.logs) ? a.logs.length : 0,
    deltaCents: typeof a.deltaCents === "number" ? a.deltaCents : 0,
  };
}

async function loadRepriceRows(
  entityIdPattern: { exact?: string; like?: string },
): Promise<RepriceAudit[]> {
  const rows = await db
    .select({ entityId: auditLog.entityId, diff: auditLog.diff, ts: auditLog.ts })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "hour_log_reprice"),
        entityIdPattern.exact
          ? eq(auditLog.entityId, entityIdPattern.exact)
          : like(auditLog.entityId, entityIdPattern.like ?? "%"),
      ),
    )
    .orderBy(desc(auditLog.ts));
  return rows
    .map((r) => parseRepriceRow(r.entityId, r.diff, r.ts))
    .filter((r): r is RepriceAudit => r !== null);
}

function actorOf(row: { actorName: string | null; actorEmail: string | null }) {
  return row.actorName ?? row.actorEmail ?? "—";
}

// ─────────────────────────────────────────────────────────────────────────
// Per-(coach, program) OVERRIDE history
// ─────────────────────────────────────────────────────────────────────────

/**
 * "$30.00 / hr — effective Jun 19 · set Aug 7 by Mark", for one coach on one
 * program, newest first.
 */
export async function readProgramRateOverrideHistory(
  coachId: string,
  programId: string,
): Promise<RateHistory> {
  const entityId = `${coachId}:${programId}`;

  const [auditRows, repriceRows, liveRows] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        diff: auditLog.diff,
        ts: auditLog.ts,
        actorName: users.name,
        actorEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(
        and(
          eq(auditLog.entityType, "program_rate_override"),
          eq(auditLog.entityId, entityId),
        ),
      )
      .orderBy(desc(auditLog.ts)),
    // The engine's composite entity id uses a DOUBLE colon, deliberately
    // distinct from the override's single-colon id.
    loadRepriceRows({ exact: `${coachId}::${programId}` }),
    db
      .select()
      .from(programRateOverrides)
      .where(
        and(
          eq(programRateOverrides.coachId, coachId),
          eq(programRateOverrides.programId, programId),
        ),
      )
      .limit(1),
  ]);

  const live = liveRows[0];
  const current = live
    ? {
        rateLabel: formatRateLabel({
          payMode: live.payMode,
          ratePer30MinCents: live.ratePer30MinCents,
          perSessionRateCents: live.perSessionRateCents,
        }),
        effectiveFrom: live.effectiveFrom,
      }
    : null;

  const entries: RateHistoryEntry[] = auditRows.map((row) => {
    const diff = (row.diff ?? {}) as AuditDiff;
    const removed = row.action === "delete";
    // A delete has no `after`; the history line describes what was REMOVED,
    // so it reads the `before` snapshot instead.
    const snap = (removed ? diff.before : diff.after) ?? {};
    const effectiveFrom = removed ? null : asDate(snap.effectiveFrom);
    return {
      id: row.id,
      rateLabel: formatRateLabel({
        payMode: asPayMode(snap.payMode),
        ratePer30MinCents: asNumber(snap.ratePer30MinCents),
        perSessionRateCents: asNumber(snap.perSessionRateCents),
      }),
      effectiveFrom,
      setAt: row.ts,
      actor: actorOf(row),
      removed,
      reprice: matchReprice(repriceRows, effectiveFrom, row.ts),
    };
  });

  return { current, entries };
}

// ─────────────────────────────────────────────────────────────────────────
// PROGRAM DEFAULT history
// ─────────────────────────────────────────────────────────────────────────

/** Keys whose presence in a shallow `program` diff means the RATE moved. */
const PROGRAM_RATE_KEYS = [
  "defaultRatePer30MinCents",
  "defaultPerSessionRateCents",
  "payMode",
  "defaultRateEffectiveFrom",
] as const;

function touchesRate(after: RateSnapshot | null | undefined): boolean {
  if (!after) return false;
  return PROGRAM_RATE_KEYS.some((k) => k in after);
}

/**
 * The program's DEFAULT rate over time. Rows that only renamed or
 * (de)activated the program are dropped — see the header on why a shallow
 * diff makes that necessary rather than optional.
 */
export async function readProgramDefaultRateHistory(
  programId: string,
): Promise<RateHistory> {
  const [auditRows, repriceRows, liveRows] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        diff: auditLog.diff,
        ts: auditLog.ts,
        actorName: users.name,
        actorEmail: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(
        and(
          eq(auditLog.entityType, "program"),
          eq(auditLog.entityId, programId),
          // Creates carry the full row; updates carry a shallow diff. Both are
          // filtered again below on whether a rate key is actually present.
          inArray(auditLog.action, ["create", "update"]),
        ),
      )
      .orderBy(desc(auditLog.ts)),
    // A program-default retro writes one group per COACH, so match on the
    // "<anything>::<programId>" suffix rather than an exact id.
    loadRepriceRows({ like: `%::${programId}` }),
    db.select().from(programs).where(eq(programs.id, programId)).limit(1),
  ]);

  const live = liveRows[0];
  const current = live
    ? {
        rateLabel: formatRateLabel({
          payMode: live.payMode,
          ratePer30MinCents: live.defaultRatePer30MinCents,
          perSessionRateCents: live.defaultPerSessionRateCents,
        }),
        effectiveFrom: live.defaultRateEffectiveFrom,
      }
    : null;

  const entries: RateHistoryEntry[] = auditRows
    .filter((row) => touchesRate(((row.diff ?? {}) as AuditDiff).after))
    .map((row) => {
      const after = ((row.diff ?? {}) as AuditDiff).after ?? {};
      // A shallow diff may omit payMode when only the amount moved, so fall
      // back to the mode the program carries today rather than assuming
      // hourly and mislabeling a per-session amount as an hourly rate — the
      // exact confusion that cost PFA months of overpaid game fees.
      const payMode =
        "payMode" in after
          ? asPayMode(after.payMode)
          : (live?.payMode ?? "hourly");
      const effectiveFrom = asDate(after.defaultRateEffectiveFrom);
      return {
        id: row.id,
        rateLabel: formatRateLabel({
          payMode,
          ratePer30MinCents:
            "defaultRatePer30MinCents" in after
              ? asNumber(after.defaultRatePer30MinCents)
              : live?.defaultRatePer30MinCents,
          perSessionRateCents:
            "defaultPerSessionRateCents" in after
              ? asNumber(after.defaultPerSessionRateCents)
              : live?.defaultPerSessionRateCents,
        }),
        effectiveFrom,
        setAt: row.ts,
        actor: actorOf(row),
        removed: false,
        reprice: matchReprice(repriceRows, effectiveFrom, row.ts),
      };
    });

  return { current, entries };
}
