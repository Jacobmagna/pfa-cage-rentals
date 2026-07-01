import Link from "next/link";
import { and, asc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { Archive, ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { auditLog, sessionsBilling, users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { totalFromSnapshot } from "@/lib/billing";
import {
  formatPfaMonthYear,
  pfaMonthEnd,
  pfaMonthStart,
} from "@/lib/timezone";
import { isSyntheticUserEmail } from "@/lib/server/user-actions";
import { AddCoachForm } from "./_components/add-coach-form";
import { CoachesTable, type CoachRow } from "./_components/coaches-table";

// /admin/coaches — list of every user with role=coach plus their
// month-to-date activity. "This month" uses pfaMonthStart/End so the
// boundary lines up with PFA-TZ midnight rather than server-UTC.
//
// Snapshot rule: per-coach owed reads sessionsBilling.ratePer30MinCents
// straight off the row. Renegotiating a coach's override changes
// FUTURE bookings only.
//
// Server-rendered; the client island handles sorting on top of the
// already-aggregated rows. For a roster of <100 coaches the round-trip
// to re-sort server-side adds latency without buying anything.

export default async function AdminCoachesPage() {
  await requireRole("admin");

  const now = new Date();
  const monthStart = pfaMonthStart(now);
  const monthEndExclusive = pfaMonthEnd(now);

  const [coachRows, sessionRows, activityRows] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        createdAt: users.createdAt,
        smsOptIn: users.smsOptIn,
        smsOptOut: users.smsOptOut,
      })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
      .orderBy(asc(users.name), asc(users.email)),
    db
      .select({
        coachId: sessionsBilling.coachId,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      })
      .from(sessionsBilling)
      .where(
        and(
          gte(sessionsBilling.startAt, monthStart),
          lt(sessionsBilling.startAt, monthEndExclusive),
        ),
      ),
    // "Last activity" = the coach's most recent REAL in-app action. Exclude
    // `user_sms_consent` rows: those are written by the SMS inbound webhook
    // when a coach texts STOP/START (a carrier opt-out, not app activity).
    // neon-http returns a raw `max()` aggregate as a tz-naive STRING (e.g.
    // "2026-07-01 18:25:22.877" — no Z), NOT a Date, so we type it string|null
    // and normalize to UTC in new Date() below (append T…Z) so the wall-clock
    // render is correct regardless of the runtime timezone. Uses the
    // audit_log_actor_idx (actor_user_id, ts) index (migration 0042).
    db
      .select({
        actorUserId: auditLog.actorUserId,
        lastActivityAt: sql<string | null>`max(${auditLog.ts})`,
      })
      .from(auditLog)
      .where(ne(auditLog.entityType, "user_sms_consent"))
      .groupBy(auditLog.actorUserId),
  ]);

  // Pre-aggregate per coach. Doing it server-side means the client
  // island doesn't carry the full session list; it gets one row per
  // coach.
  const totals = new Map<string, { count: number; cents: number }>();
  for (const s of sessionRows) {
    const total = totalFromSnapshot(s.startAt, s.endAt, s.ratePer30MinCents);
    const entry = totals.get(s.coachId) ?? { count: 0, cents: 0 };
    entry.count += 1;
    entry.cents += total;
    totals.set(s.coachId, entry);
  }

  const lastActivity = new Map<string, Date>(
    activityRows
      .filter((r) => r.lastActivityAt !== null)
      // The tz-naive string ("YYYY-MM-DD HH:MM:SS.ffffff") is UTC wall-clock;
      // rewrite to ISO-with-Z so new Date() parses it as UTC on any runtime.
      .map((r) => [
        r.actorUserId,
        new Date((r.lastActivityAt as string).replace(" ", "T") + "Z"),
      ]),
  );

  const rows: CoachRow[] = coachRows.map((c) => {
    const t = totals.get(c.id);
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      joinedAt: c.createdAt,
      lastActivityAt: lastActivity.get(c.id) ?? null,
      receivesTexts: c.smsOptIn && !c.smsOptOut,
      sessionsThisMonth: t?.count ?? 0,
      owedThisMonthCents: t?.cents ?? 0,
      isSynthetic: isSyntheticUserEmail(c.email),
    };
  });

  // Merge targets = every coach. Synthetic-into-synthetic is allowed
  // because the historical import can create multiple pseudo-coaches
  // for what's logically one entity (e.g. "PFA Travel" + "PFA Summer
  // Travel" + "PFA Travel JT" should consolidate into a single PFA
  // Travel pseudo-coach). The merge dialog itself excludes the source
  // row from the dropdown.
  const mergeTargets = rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
  }));

  const monthLabel = formatPfaMonthYear(now);

  return (
    <>
      <Link
        href="/admin/records"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Billing &amp; Records
      </Link>

      <div className="mb-6 space-y-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Coaches
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {rows.length} {rows.length === 1 ? "coach" : "coaches"}
        </h1>
        <p className="text-sm text-fg-muted">
          Month-to-date activity for {monthLabel}. Click a coach to view
          their detail page.
        </p>
        <p className="text-xs italic text-fg-subtle md:hidden">
          This page is designed for desktop. Rotate your device or use a
          laptop for the full experience.
        </p>
        <Link
          href="/admin/coaches/archive"
          className="inline-flex items-center gap-1.5 pt-1 text-xs font-medium text-fg-muted hover:text-fg transition-colors"
        >
          <Archive className="h-3.5 w-3.5" />
          Archived coaches
        </Link>
      </div>

      <AddCoachForm />

      <CoachesTable rows={rows} mergeTargets={mergeTargets} />
    </>
  );
}
