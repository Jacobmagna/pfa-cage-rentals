// Data-Safe Snapshot — the orchestrator. Derives a COMPLETED week, runs the
// read-only aggregates, and (on a real run) appends them to the central
// store. The ONLY callers are the /api/cron route and the dry-run CLI;
// nothing on the live path imports this.
//
// DORMANT-SAFE: with the DATA_SAFE_* env unset, a real run returns
// { status: "disabled" } immediately and does no DB work. A dry-run always
// runs (using a fixed dev salt if none is configured) so the CLI can inspect
// the de-identified facts without ever pushing.

import { db } from "@/db";
import {
  PFA_TIMEZONE,
  pfaParts,
  pfaWallClockToUtc,
} from "@/lib/timezone";

import { computeAggregates } from "./aggregate";
import { getDataSafeConfig } from "./config";
import { pushFacts } from "./exporter";
import type { OpFact } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SnapshotPeriod = {
  periodStart: Date;
  periodEnd: Date;
};

export type SnapshotSummary =
  | { status: "disabled" }
  | { status: "dry-run"; period: SnapshotPeriod; facts: OpFact[] }
  | {
      status: "pushed";
      period: SnapshotPeriod;
      inserted: number;
      attempted: number;
    };

/**
 * The most recent fully-ended Monday→Monday week in the FACILITY timezone,
 * as a half-open UTC range [periodStart, periodEnd). `weeksAgo` shifts the
 * window back N additional weeks (for testing / backfill inspection).
 *
 * Anchoring is DST-safe: we find the Monday at PFA-local midnight that began
 * the most recently COMPLETED week (i.e. the Monday a week ago relative to
 * the current week's Monday), then read its PFA calendar date and snap both
 * boundaries to PFA midnight via pfaWallClockToUtc.
 */
export function completedWeekPeriod(
  now: Date = new Date(),
  weeksAgo = 0,
): SnapshotPeriod {
  // PFA-local weekday (0=Sun..6=Sat) of a noon anchor today (noon is never in
  // the spring-forward gap).
  const p = pfaParts(now);
  const todayNoon = pfaWallClockToUtc(
    `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    "12:00",
  );
  const longName = new Intl.DateTimeFormat("en-US", {
    timeZone: PFA_TIMEZONE,
    weekday: "long",
  }).format(todayNoon);
  const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const dow = WEEKDAYS.indexOf(longName);
  // Days back to THIS week's Monday (Mon=0 days back, Sun=6 days back).
  const daysToThisMonday = (dow + 6) % 7;

  // The start of the most recently COMPLETED week is the Monday one week
  // before this week's Monday, then shifted back `weeksAgo` more weeks.
  const startNoon = new Date(
    todayNoon.getTime() - (daysToThisMonday + 7 * (weeksAgo + 1)) * DAY_MS,
  );
  // The end is exactly 7 days after the start (the following Monday).
  const endNoon = new Date(startNoon.getTime() + 7 * DAY_MS);

  const sP = pfaParts(startNoon);
  const eP = pfaParts(endNoon);
  const periodStart = pfaWallClockToUtc(
    `${sP.year}-${pad2(sP.month)}-${pad2(sP.day)}`,
    "00:00",
  );
  const periodEnd = pfaWallClockToUtc(
    `${eP.year}-${pad2(eP.month)}-${pad2(eP.day)}`,
    "00:00",
  );
  return { periodStart, periodEnd };
}

/**
 * Runs a snapshot for a completed week.
 *
 * - Real run (`!dryRun`): refuses unless the capability is enabled AND
 *   databaseUrl + clientId + vertical + salt are all set (coach ids MUST be
 *   salted before they leave). Computes aggregates → pushFacts → returns the
 *   push counts.
 * - Dry run: always computes (using a fixed dev salt if none configured) and
 *   returns the facts WITHOUT pushing.
 */
export async function runSnapshot(opts?: {
  dryRun?: boolean;
  weeksAgo?: number;
}): Promise<SnapshotSummary> {
  const dryRun = opts?.dryRun ?? false;
  const weeksAgo = opts?.weeksAgo ?? 0;
  const cfg = getDataSafeConfig();

  if (!dryRun && !cfg.enabled) {
    return { status: "disabled" };
  }

  const period = completedWeekPeriod(new Date(), weeksAgo);

  // A real push REQUIRES a configured salt; a dry-run falls back to a fixed
  // dev salt so the facts are computable for inspection (the tokens are
  // throwaway and never leave the operator's terminal).
  const salt = cfg.salt ?? (dryRun ? "dryrun-dev-salt" : "");

  const facts = await computeAggregates(db, {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    salt,
    k: cfg.k,
  });

  if (dryRun) {
    return { status: "dry-run", period, facts };
  }

  // Real run: require everything needed to push de-identified, salted facts.
  if (!cfg.databaseUrl || !cfg.clientId || !cfg.vertical || !cfg.salt) {
    throw new Error(
      "Data-Safe push refused: DATA_SAFE_DATABASE_URL, DATA_SAFE_CLIENT_ID, " +
        "DATA_SAFE_VERTICAL, and DATA_SAFE_SALT must all be set for a real " +
        "push (coach ids must be salted before they leave the source).",
    );
  }

  // Deterministic run id from the period start so re-runs of the same week
  // are auditable and dedupe at the store via the unique idempotency key.
  const sourceRunId = `${period.periodStart.toISOString()}`;

  const { inserted, attempted } = await pushFacts(facts, {
    databaseUrl: cfg.databaseUrl,
    anonClientId: cfg.clientId,
    vertical: cfg.vertical,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    sourceRunId,
  });

  return { status: "pushed", period, inserted, attempted };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
