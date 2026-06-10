// Demo-video data generator. Runs AFTER `db:seed` against the
// INTEGRATION branch only (guarded in db.ts). `db:seed` creates the
// static catalog — resources, rate defaults, 88 athletes, 9 programs,
// 33 coaches — but NO enrollments, schedule, rentals, hours,
// attendance, payments, or activity, so the most important screens
// would render empty. This populates believable, CURRENT-WEEK data so
// every tour screen looks full.
//
// IDEMPOTENT: it clears the dynamic tables it owns (schedule blocks +
// their coach links + linked blocked_times, rentals, hour logs,
// attendance, payments, audit rows) and the demo enrollments, then
// recreates them anchored to "today" in PFA time. The static catalog
// from db:seed (athletes/coaches/programs/resources/rates) is never
// touched. Re-running replaces the demo set wholesale.
//
// Run via: tsx scripts/demo-video/seed-demo-data.ts

import { and, eq, sql } from "drizzle-orm";
import { demoDb } from "./db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  attendanceSessions,
  auditLog,
  blockedTimes,
  coachPayments,
  coachPrograms,
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  rateDefaults,
  resources,
  sessionsBilling,
  users,
} from "../../src/db/schema";
import {
  PFA_TIMEZONE,
  pfaParts,
  pfaWallClockToUtc,
} from "../../src/lib/timezone";

const DEMO_ADMIN_EMAIL = "demo-admin@pfa.invalid";
const DEMO_COACH_EMAIL = "demo-coach@pfa.invalid";

// ---------------------------------------------------------------------------
// Date helpers — anchor everything to the CURRENT PFA week so "today"
// views are full.
// ---------------------------------------------------------------------------

/** Today's PFA calendar date as "YYYY-MM-DD". */
function pfaTodayStr(now = new Date()): string {
  const p = pfaParts(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Add `days` calendar days to a "YYYY-MM-DD" string (UTC-noon math). */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** PFA-local weekday index (0=Sun..6=Sat) for a "YYYY-MM-DD". */
function weekdayOf(dateStr: string): number {
  const noon = pfaWallClockToUtc(dateStr, "12:00");
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: PFA_TIMEZONE,
    weekday: "long",
  }).format(noon);
  return [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ].indexOf(name);
}

/** A UTC instant for `time` ("HH:MM") on PFA calendar day `dateStr`. */
function at(dateStr: string, time: string): Date {
  return pfaWallClockToUtc(dateStr, time);
}

async function main() {
  const db = demoDb();
  const now = new Date();
  const today = pfaTodayStr(now);

  // The Sunday at/before today → start of this PFA week.
  const sunday = addDays(today, -weekdayOf(today));
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(sunday, i));
  // mon..fri of THIS week
  const [, mon, tue, wed, thu, fri] = weekDates;
  console.log(
    `[demo] anchoring to PFA week ${weekDates[0]} … ${weekDates[6]} (today ${today})`,
  );

  // -------------------------------------------------------------------------
  // 1. Demo users (admin + coach). The coach gets a real-sounding name +
  //    phone so coach screens look real. Upsert (idempotent).
  // -------------------------------------------------------------------------
  await db
    .insert(users)
    .values({
      email: DEMO_ADMIN_EMAIL,
      name: "Coach Dad (Owner)",
      role: "admin",
    })
    .onConflictDoUpdate({
      target: users.email,
      set: { role: "admin", name: "Coach Dad (Owner)" },
    });
  await db
    .insert(users)
    .values({
      email: DEMO_COACH_EMAIL,
      name: "Marcus Bell",
      role: "coach",
      phone: "(559) 555-0142",
    })
    .onConflictDoUpdate({
      target: users.email,
      set: { role: "coach", name: "Marcus Bell", phone: "(559) 555-0142" },
    });

  const demoAdmin = (
    await db.select().from(users).where(eq(users.email, DEMO_ADMIN_EMAIL)).limit(1)
  )[0];
  const demoCoach = (
    await db.select().from(users).where(eq(users.email, DEMO_COACH_EMAIL)).limit(1)
  )[0];
  if (!demoAdmin || !demoCoach) throw new Error("demo users missing after upsert");

  // -------------------------------------------------------------------------
  // 2. Pull the catalog seeded by db:seed.
  // -------------------------------------------------------------------------
  const allResources = await db.select().from(resources);
  const cages = allResources.filter((r) => r.type === "cage");
  const bullpens = allResources.filter((r) => r.type === "bullpen");
  const weightRooms = allResources.filter((r) => r.type === "weight_room");
  if (cages.length === 0) {
    throw new Error("No cage resources — run `db:seed` against integration first.");
  }

  const allPrograms = await db.select().from(programs).where(eq(programs.active, true));
  if (allPrograms.length === 0) {
    throw new Error("No programs — run `db:seed` against integration first.");
  }
  const programByName = (n: string) =>
    allPrograms.find((p) => p.name === n) ?? allPrograms[0];

  const allAthletes = await db
    .select()
    .from(athletes)
    .where(sql`${athletes.archivedAt} is null`);
  if (allAthletes.length < 10) {
    throw new Error("Too few athletes — run `db:seed` against integration first.");
  }

  // Real seeded coaches (exclude our demo users + soft-deleted). We use a
  // handful as the "other coaches" populating the schedule + rentals.
  const realCoaches = (
    await db
      .select()
      .from(users)
      .where(and(eq(users.role, "coach"), sql`${users.deletedAt} is null`))
  ).filter((c) => c.email !== DEMO_COACH_EMAIL);
  // Build the coach pool: demo coach FIRST so they own the most data, then
  // a few real coaches for variety.
  const coachPool = [demoCoach, ...realCoaches.slice(0, 6)];

  // A program-default pay rate so "program pay" is non-zero on reports.
  // (db:seed leaves program rates NULL.) Set a per-hour-ish default.
  const PROGRAM_RATE_PER_30 = 1500; // $15.00 / 30min = $30/hr
  await db
    .update(programs)
    .set({ defaultRatePer30MinCents: PROGRAM_RATE_PER_30 })
    .where(sql`${programs.defaultRatePer30MinCents} is null`);

  const cageRate =
    (await db.select().from(rateDefaults).where(eq(rateDefaults.type, "cage")).limit(1))[0]
      ?.ratePer30MinCents ?? 2200;
  const bullpenRate =
    (await db.select().from(rateDefaults).where(eq(rateDefaults.type, "bullpen")).limit(1))[0]
      ?.ratePer30MinCents ?? 2200;

  // -------------------------------------------------------------------------
  // 3. Clear the dynamic demo tables (idempotent rerun). We own everything
  //    in these tables on the integration branch, so a full clear is safe
  //    and keeps the rerun simple. Static catalog (users/athletes/programs/
  //    resources/rates) is NEVER cleared.
  // -------------------------------------------------------------------------
  console.log("[demo] clearing dynamic tables for a clean rebuild…");
  await db.delete(attendanceRecords);
  await db.delete(attendanceSessions);
  await db.delete(hourLogs);
  await db.delete(coachPayments);
  await db.delete(programScheduleBlockCoaches);
  // blocked_times that are linked to a program block cascade when the block
  // is deleted; clear the rest (cage rentals occupy via blocked_times too in
  // some flows, but we recreate them fresh) — delete all blocked_times then
  // all program blocks.
  await db.delete(blockedTimes);
  await db.delete(programScheduleBlocks);
  await db.delete(sessionsBilling);
  await db.delete(athletePrograms);
  // Remove our demo audit rows (tagged) — leave any real audit history.
  await db
    .delete(auditLog)
    .where(sql`${auditLog.entityType} like 'demo_%'`);

  // -------------------------------------------------------------------------
  // 4. Enrollments — spread athletes across several programs, some capped.
  // -------------------------------------------------------------------------
  console.log("[demo] enrollments…");
  // Enroll into the EXACT named programs the demo surfaces use (schedule
  // blocks, hour logs, attendance, coach attendance), not an arbitrary
  // slice(0,6) of all active programs. The integration DB can contain
  // leftover "Attendance Test Program …" rows that sort first; enrolling
  // into those would leave the real, on-screen programs (e.g. "HS Summer
  // Program", which /coach/attendance + /admin/attendance/by-program show)
  // with zero athletes. Resolve canonical names, de-dupe by id, and fall
  // back to filling from the active catalog if any are missing.
  const ENROLL_PROGRAM_NAMES = [
    "HS Summer Program",
    "Youth Summer Camp",
    "HS Summer Program-Hitting",
    "HS Summer Travel Team",
    "HS Summer Program-Throwing",
    "HS Summer Program-Catching",
  ];
  const enrollProgramsRaw = ENROLL_PROGRAM_NAMES.map((n) => programByName(n));
  const seenProgId = new Set<string>();
  const enrollPrograms = enrollProgramsRaw.filter((p) => {
    if (!p || seenProgId.has(p.id)) return false;
    seenProgId.add(p.id);
    return true;
  });
  // Top up to 6 with any other active programs if names didn't resolve.
  for (const p of allPrograms) {
    if (enrollPrograms.length >= 6) break;
    if (!seenProgId.has(p.id)) {
      enrollPrograms.push(p);
      seenProgId.add(p.id);
    }
  }
  console.log(
    `[demo] enrolling into programs: ${enrollPrograms.map((p) => p.name).join(", ")}`,
  );
  const enrollRows: (typeof athletePrograms.$inferInsert)[] = [];
  allAthletes.slice(0, 60).forEach((a, i) => {
    // each athlete in 1–2 programs
    const p1 = enrollPrograms[i % enrollPrograms.length];
    enrollRows.push({
      athleteId: a.id,
      programId: p1.id,
      // sprinkle per-athlete caps so the cap UI shows on Roster/Attendance
      ...(i % 5 === 0
        ? { cap: 2, capPeriod: "week" as const }
        : i % 7 === 0
          ? { cap: 12, capPeriod: "total" as const }
          : {}),
    });
    if (i % 3 === 0) {
      const p2 = enrollPrograms[(i + 2) % enrollPrograms.length];
      if (p2.id !== p1.id) {
        enrollRows.push({ athleteId: a.id, programId: p2.id });
      }
    }
  });
  // dedupe (athlete,program)
  const seenEnroll = new Set<string>();
  const dedupedEnroll = enrollRows.filter((r) => {
    const k = `${r.athleteId}:${r.programId}`;
    if (seenEnroll.has(k)) return false;
    seenEnroll.add(k);
    return true;
  });
  await db.insert(athletePrograms).values(dedupedEnroll);

  // Coach ↔ program access so coaches can run programs (idempotent).
  const coachProgramRows: (typeof coachPrograms.$inferInsert)[] = [];
  for (const c of coachPool) {
    for (const p of enrollPrograms.slice(0, 4)) {
      coachProgramRows.push({ coachId: c.id, programId: p.id });
    }
  }
  await db
    .insert(coachPrograms)
    .values(coachProgramRows)
    .onConflictDoNothing();

  // -------------------------------------------------------------------------
  // 5. Program schedule blocks — a full weekday grid this week, multiple
  //    programs, multiple coaches on some, across cage/bullpen/weight
  //    resources. Link a few to a cage resource via blocked_times.
  // -------------------------------------------------------------------------
  console.log("[demo] program schedule blocks…");
  type BlockPlan = {
    day: string;
    start: string;
    end: string;
    program: string;
    coaches: typeof users.$inferSelect[];
    occupyResourceId?: string; // link a cage block via blocked_times
  };
  const P = (n: string) => programByName(n);
  const plans: BlockPlan[] = [
    // Demo coach is on several so /coach/schedule is full.
    { day: mon, start: "09:00", end: "10:30", program: "HS Summer Program", coaches: [demoCoach, coachPool[1]].filter(Boolean), occupyResourceId: cages[0]?.id },
    { day: mon, start: "16:00", end: "17:30", program: "Youth Summer Camp", coaches: [coachPool[2]].filter(Boolean) },
    { day: tue, start: "10:00", end: "11:15", program: "HS Summer Program-Hitting", coaches: [demoCoach].filter(Boolean), occupyResourceId: cages[1]?.id },
    { day: tue, start: "15:30", end: "17:00", program: "HS Summer Travel Team", coaches: [coachPool[3], coachPool[1]].filter(Boolean) },
    { day: wed, start: "09:00", end: "10:30", program: "HS Summer Program-Throwing", coaches: [demoCoach, coachPool[2]].filter(Boolean), occupyResourceId: bullpens[0]?.id },
    { day: wed, start: "14:00", end: "15:30", program: "Youth Summer Camp", coaches: [coachPool[4]].filter(Boolean) },
    { day: thu, start: "10:00", end: "11:00", program: "HS Summer Program-Catching", coaches: [demoCoach].filter(Boolean) },
    { day: thu, start: "16:30", end: "18:00", program: "HS Summer Travel Team", coaches: [coachPool[1], coachPool[5]].filter(Boolean) },
    { day: fri, start: "09:30", end: "11:00", program: "HS Summer Program", coaches: [demoCoach, coachPool[3]].filter(Boolean), occupyResourceId: cages[2]?.id },
    { day: fri, start: "13:00", end: "14:00", program: "Cleaning", coaches: [coachPool[2]].filter(Boolean) },
    // A weight-room program block
    { day: tue, start: "13:00", end: "14:00", program: "HS Summer Travel Team", coaches: [coachPool[4]].filter(Boolean), occupyResourceId: weightRooms[0]?.id },
  ];

  for (const plan of plans) {
    const prog = P(plan.program);
    const primary = plan.coaches[0] ?? demoCoach;
    const [block] = await db
      .insert(programScheduleBlocks)
      .values({
        programId: prog.id,
        scheduledCoachId: primary.id,
        startAt: at(plan.day, plan.start),
        endAt: at(plan.day, plan.end),
        note: null,
        createdBy: demoAdmin.id,
      })
      .returning({ id: programScheduleBlocks.id });
    // coach membership set (primary + extras)
    const memberRows = plan.coaches.map((c) => ({ blockId: block.id, coachId: c.id }));
    await db.insert(programScheduleBlockCoaches).values(memberRows).onConflictDoNothing();
    // occupy a resource via a linked blocked_time so it shows on both calendars
    if (plan.occupyResourceId) {
      await db.insert(blockedTimes).values({
        resourceId: plan.occupyResourceId,
        startAt: at(plan.day, plan.start),
        endAt: at(plan.day, plan.end),
        reason: `${prog.name} (program)`,
        programScheduleBlockId: block.id,
        createdBy: demoAdmin.id,
      });
    }
  }

  // A PAST block that ended before today with NO matching log for a member
  // coach → derived no-show on the Home "Needs review" card. Use a real
  // coach (not the demo coach, since the demo coach will have logs) on a
  // block earlier this week / last week.
  const noShowCoach = coachPool[3] ?? coachPool[1] ?? demoCoach;
  const noShowDay = addDays(today, -2);
  {
    const prog = P("Youth Summer Camp");
    const [block] = await db
      .insert(programScheduleBlocks)
      .values({
        programId: prog.id,
        scheduledCoachId: noShowCoach.id,
        startAt: at(noShowDay, "10:00"),
        endAt: at(noShowDay, "11:00"),
        createdBy: demoAdmin.id,
      })
      .returning({ id: programScheduleBlocks.id });
    await db
      .insert(programScheduleBlockCoaches)
      .values({ blockId: block.id, coachId: noShowCoach.id })
      .onConflictDoNothing();
  }

  // -------------------------------------------------------------------------
  // 6. Cage/bullpen rentals (sessions_billing) — this week + past weeks.
  // -------------------------------------------------------------------------
  console.log("[demo] rentals (sessions_billing)…");
  const rentalRows: (typeof sessionsBilling.$inferInsert)[] = [];
  const pushRental = (
    coach: typeof users.$inferSelect,
    resource: typeof resources.$inferSelect,
    day: string,
    start: string,
    end: string,
    rate: number,
  ) => {
    rentalRows.push({
      coachId: coach.id,
      resourceId: resource.id,
      startAt: at(day, start),
      endAt: at(day, end),
      useType: resource.type === "cage" ? "hitting" : null,
      note: null,
      ratePer30MinCents: rate,
      createdBy: coach.id,
    });
  };
  // This week — demo coach owns several (so coach Rentals + What-you-owe full)
  pushRental(demoCoach, cages[3] ?? cages[0], mon, "11:00", "12:00", cageRate);
  pushRental(demoCoach, cages[4] ?? cages[0], wed, "16:00", "17:00", cageRate);
  pushRental(demoCoach, cages[0], thu, "13:00", "14:00", cageRate);
  pushRental(demoCoach, bullpens[1] ?? bullpens[0] ?? cages[0], fri, "15:00", "15:30", bullpenRate);
  // Other coaches this week
  pushRental(coachPool[1] ?? demoCoach, cages[1], mon, "13:00", "14:00", cageRate);
  pushRental(coachPool[2] ?? demoCoach, cages[2], tue, "12:00", "13:00", cageRate);
  pushRental(coachPool[3] ?? demoCoach, cages[3] ?? cages[0], wed, "11:00", "12:00", cageRate);
  pushRental(coachPool[4] ?? demoCoach, cages[4] ?? cages[0], thu, "10:00", "11:00", cageRate);
  pushRental(coachPool[1] ?? demoCoach, bullpens[0] ?? cages[0], fri, "11:00", "12:00", bullpenRate);
  // Past weeks (1–3 weeks back) so Payments/Reports owed side is non-trivial.
  for (let w = 1; w <= 3; w++) {
    const base = addDays(sunday, -7 * w);
    pushRental(demoCoach, cages[0], addDays(base, 1), "10:00", "11:00", cageRate);
    pushRental(demoCoach, cages[1], addDays(base, 3), "14:00", "15:00", cageRate);
    pushRental(coachPool[1] ?? demoCoach, cages[2], addDays(base, 2), "11:00", "12:00", cageRate);
    pushRental(coachPool[2] ?? demoCoach, cages[3] ?? cages[0], addDays(base, 4), "16:00", "17:00", cageRate);
    pushRental(coachPool[3] ?? demoCoach, bullpens[0] ?? cages[0], addDays(base, 1), "09:00", "10:00", bullpenRate);
  }
  // Insert one at a time to dodge the resource-overlap EXCLUDE constraint
  // surprising us; on conflict we just skip that one.
  let rentalInserted = 0;
  for (const r of rentalRows) {
    try {
      await db.insert(sessionsBilling).values(r);
      rentalInserted++;
    } catch (e) {
      // overlap or other constraint — skip, keep the demo resilient
      console.warn(`[demo] skipped a rental (constraint): ${(e as Error).message.slice(0, 80)}`);
    }
  }
  console.log(`[demo] rentals inserted: ${rentalInserted}/${rentalRows.length}`);

  // -------------------------------------------------------------------------
  // 7. Hour logs — posted logs for the demo coach + others. One matches a
  //    scheduled block exactly (clean), at least one UNSCHEDULED (flagged),
  //    and one HELD so the held queue is non-empty.
  // -------------------------------------------------------------------------
  console.log("[demo] hour logs…");
  const hlRows: (typeof hourLogs.$inferInsert)[] = [];
  // Clean: matches the demo coach's Monday HS Summer Program block exactly.
  hlRows.push({
    coachId: demoCoach.id,
    programId: P("HS Summer Program").id,
    startAt: at(mon, "09:00"),
    endAt: at(mon, "10:30"),
    note: "Ran morning group.",
    ratePer30MinCents: PROGRAM_RATE_PER_30,
    status: "posted",
    createdBy: demoCoach.id,
  });
  // Clean: matches Tuesday hitting block.
  hlRows.push({
    coachId: demoCoach.id,
    programId: P("HS Summer Program-Hitting").id,
    startAt: at(tue, "10:00"),
    endAt: at(tue, "11:15"),
    ratePer30MinCents: PROGRAM_RATE_PER_30,
    status: "posted",
    createdBy: demoCoach.id,
  });
  // UNSCHEDULED: demo coach logs a program with no matching block (flagged).
  hlRows.push({
    coachId: demoCoach.id,
    programId: P("HS Summer Travel Team").id,
    startAt: at(wed, "11:30"),
    endAt: at(wed, "12:30"),
    note: "Extra cage work with travel guys.",
    ratePer30MinCents: PROGRAM_RATE_PER_30,
    status: "posted",
    createdBy: demoCoach.id,
  });
  // Another coach's clean log against their block.
  hlRows.push({
    coachId: coachPool[1]?.id ?? demoCoach.id,
    programId: P("HS Summer Travel Team").id,
    startAt: at(tue, "15:30"),
    endAt: at(tue, "17:00"),
    ratePer30MinCents: PROGRAM_RATE_PER_30,
    status: "posted",
    createdBy: coachPool[1]?.id ?? demoCoach.id,
  });
  // HELD: an anomalous manual log awaiting admin approval.
  hlRows.push({
    coachId: coachPool[2]?.id ?? demoCoach.id,
    programId: P("Youth Summer Camp").id,
    startAt: at(thu, "08:00"),
    endAt: at(thu, "12:00"),
    note: "Long session — flagged for review.",
    ratePer30MinCents: PROGRAM_RATE_PER_30,
    status: "held",
    heldReason: "over_logged",
    createdBy: coachPool[2]?.id ?? demoCoach.id,
  });
  // A few past-week logs for payroll depth.
  for (let w = 1; w <= 2; w++) {
    const base = addDays(sunday, -7 * w);
    hlRows.push({
      coachId: demoCoach.id,
      programId: P("HS Summer Program").id,
      startAt: at(addDays(base, 1), "09:00"),
      endAt: at(addDays(base, 1), "10:30"),
      ratePer30MinCents: PROGRAM_RATE_PER_30,
      status: "posted",
      createdBy: demoCoach.id,
    });
  }
  let hlInserted = 0;
  for (const r of hlRows) {
    try {
      await db.insert(hourLogs).values(r).onConflictDoNothing();
      hlInserted++;
    } catch (e) {
      console.warn(`[demo] skipped an hour log: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  console.log(`[demo] hour logs inserted: ${hlInserted}/${hlRows.length}`);

  // -------------------------------------------------------------------------
  // 8. Attendance — mark present/absent for a few past sessions.
  // -------------------------------------------------------------------------
  console.log("[demo] attendance…");
  const attnPrograms = enrollPrograms.slice(0, 3);
  const attnDays = [addDays(today, -1), addDays(today, -3), addDays(today, -8)];
  for (const prog of attnPrograms) {
    // enrolled athletes for this program
    const enrolled = dedupedEnroll
      .filter((e) => e.programId === prog.id)
      .map((e) => e.athleteId);
    if (enrolled.length === 0) continue;
    for (const day of attnDays) {
      const [sessRow] = await db
        .insert(attendanceSessions)
        .values({ programId: prog.id, sessionDate: day, createdBy: demoCoach.id })
        .onConflictDoNothing()
        .returning({ id: attendanceSessions.id });
      const sessId =
        sessRow?.id ??
        (
          await db
            .select({ id: attendanceSessions.id })
            .from(attendanceSessions)
            .where(
              and(
                eq(attendanceSessions.programId, prog.id),
                eq(attendanceSessions.sessionDate, day),
              ),
            )
            .limit(1)
        )[0]?.id;
      if (!sessId) continue;
      const recs = enrolled.map((athleteId, idx) => ({
        sessionId: sessId,
        athleteId,
        present: idx % 4 !== 0, // ~75% present, mix of absent
        recordedBy: demoCoach.id,
      }));
      await db.insert(attendanceRecords).values(recs).onConflictDoNothing();
    }
  }

  // -------------------------------------------------------------------------
  // 9. Coach payments (confirmed) so Payments shows in/out + balances.
  // -------------------------------------------------------------------------
  console.log("[demo] payments…");
  await db.insert(coachPayments).values([
    {
      coachId: demoCoach.id,
      amountCents: 8800,
      method: "zelle",
      paidAt: at(addDays(today, -5), "12:00"),
      reference: "Zelle #4471",
      status: "confirmed",
      recordedBy: demoAdmin.id,
      confirmedBy: demoAdmin.id,
      confirmedAt: at(addDays(today, -5), "12:05"),
    },
    {
      coachId: coachPool[1]?.id ?? demoCoach.id,
      amountCents: 4400,
      method: "cash",
      paidAt: at(addDays(today, -9), "17:00"),
      status: "confirmed",
      recordedBy: demoAdmin.id,
      confirmedBy: demoAdmin.id,
      confirmedAt: at(addDays(today, -9), "17:01"),
    },
    // a pending one so the inbox is non-empty
    {
      coachId: coachPool[2]?.id ?? demoCoach.id,
      amountCents: 4400,
      method: "venmo",
      paidAt: at(addDays(today, -1), "10:00"),
      reference: "self-reported",
      status: "pending",
      recordedBy: coachPool[2]?.id ?? demoCoach.id,
    },
  ]);

  // -------------------------------------------------------------------------
  // 10. Recent activity — a few audit_log rows (coach actions) dated in the
  //     last day or two so Home's "Recent activity" feed isn't empty. We tag
  //     entityType "demo_*" so the idempotent clear above can reclaim them.
  // -------------------------------------------------------------------------
  console.log("[demo] recent activity (audit_log)…");
  const activity: (typeof auditLog.$inferInsert)[] = [
    {
      actorUserId: demoCoach.id,
      entityType: "demo_hour_log",
      entityId: crypto.randomUUID(),
      action: "create",
      diff: { after: { program: "HS Summer Program", hours: 1.5 } },
      ts: at(today, "08:12"),
    },
    {
      actorUserId: coachPool[1]?.id ?? demoCoach.id,
      entityType: "demo_session",
      entityId: crypto.randomUUID(),
      action: "create",
      diff: { after: { resource: "Cage 2", rental: true } },
      ts: at(addDays(today, -1), "13:40"),
    },
    {
      actorUserId: coachPool[2]?.id ?? demoCoach.id,
      entityType: "demo_attendance",
      entityId: crypto.randomUUID(),
      action: "update",
      diff: { before: { present: false }, after: { present: true } },
      ts: at(addDays(today, -1), "16:05"),
    },
  ];
  await db.insert(auditLog).values(activity);

  console.log("[demo] seed-demo-data complete.");
}

main().catch((err) => {
  console.error("[demo] seed-demo-data FAILED:", err);
  process.exit(1);
});
