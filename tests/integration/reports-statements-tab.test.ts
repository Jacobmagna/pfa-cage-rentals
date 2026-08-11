// payment-statement SPEC Phase C — the Statements sub-tab, wired to real rows
// on a real Neon dev branch.
//
// The engine's arithmetic is already covered exhaustively by unit tests with
// literals. What only a real DB can prove is the part in between:
//
//   1. 🔴 `coversThrough` SURVIVES THE ROUND TRIP AND BUCKETS BY PERIOD.
//      Alex Milone owed $660 for July and Zelled it on Aug 7. Written to
//      Postgres and read back through Drizzle, that payment must land on the
//      JULY statement and be absent from AUGUST's rows — the exact opposite of
//      what bucketing by `paidAt` produces, which would report July as still
//      outstanding AND August as a phantom credit (SPEC §1, §12.6).
//   2. The fetch is NOT period-filtered, so an opening balance computed from
//      charges that predate the period is real rather than always $0.00.
//   3. ONE coach in scope → a statement; zero or many → the roll-up (SPEC §8.1).
//   4. The work account quotes the SAME total as /admin/reports?tab=work for
//      the same coach and period (SPEC §10 — asserted, not eyeballed).
//   5. The statement reconciles to `netCoachLedgers`, the all-time figure
//      /admin/payments has shown all summer (SPEC §7).
//   6. The shared filter contract still lands each of the four tabs on itself
//      and still keeps the download route tab-free (SPEC §10 / §13 Phase C).
//
// ⚠️ `truncateMutables()` does NOT touch hour_logs or programs, so this file
// creates its own uniquely-named program and cleans up after itself. It DOES
// truncate sessions_billing and coach_payments, so those are created per test.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { coachPayments, hourLogs, programs, sessionsBilling } from "@/db/schema";
import { netCoachLedgers } from "@/lib/payment-ledger";
import {
  filtersFromURLSearchParams,
  normalizeFilters,
  type NormalizedFilters,
} from "@/lib/reports/filters";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import { hourLogFiltersFromReportFilters } from "@/lib/reports/hour-log-filters";
import { REPORT_TABS, normalizeReportTab } from "@/lib/reports/tabs";
import { buildWorkReport } from "@/lib/reports/work-report";
import {
  buildStatementPair,
  buildStatementRoster,
} from "@/lib/statement/engine";
import {
  fetchStatementCoaches,
  singleCoachInScope,
} from "@/lib/statement/fetch";
import { statementHref } from "@/lib/statement/links";
import { normalizeStatementAccount } from "@/lib/statement/types";
import { parsePfaInput } from "@/lib/timezone";
import { ensureFixtureUsers, getSeededResources, truncateMutables } from "./fixtures";

let coachA: string;
let coachB: string;
let adminId: string;
let cageResourceId: string;
let programId: string;
const createdLogIds: string[] = [];

/** $22/30min = $44/hr — PFA's real cage rate, so the money is checkable. */
const CAGE_RATE_PER_30_MIN = 2_200;
/** $15/30min = $30/hr — Alex's real work rate. */
const WORK_RATE_PER_30_MIN = 1_500;

const JUNE = period("2026-06-01", "2026-06-30");
const JULY = period("2026-07-01", "2026-07-31");
const AUGUST = period("2026-08-01", "2026-08-31");

/** The real filter parser, so the boundaries are production's. */
function period(from: string, to: string): NormalizedFilters {
  return normalizeFilters({ from, to });
}

function at(date: string, time: string): Date {
  return parsePfaInput(date, time);
}

beforeAll(async () => {
  const fixtures = await ensureFixtureUsers();
  coachA = fixtures.coach.id;
  coachB = fixtures.flaggedCoach.id;
  adminId = fixtures.admin.id;
  cageResourceId = (await getSeededResources()).cage1.id;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [program] = await db
    .insert(programs)
    .values({ name: `Statement Tab Program ${stamp}`, active: true })
    .returning({ id: programs.id });
  programId = program.id;

  // Work: 2h on Jul 6 at $30/hr → $60.00, plus 2h on Jun 8 → $60.00 (which
  // becomes July's work OPENING balance). Posted, so the Work tab counts them.
  const logs = await db
    .insert(hourLogs)
    .values([
      {
        coachId: coachA,
        programId,
        startAt: at("2026-06-08", "09:00"),
        endAt: at("2026-06-08", "11:00"),
        ratePer30MinCents: WORK_RATE_PER_30_MIN,
        status: "posted",
        createdBy: adminId,
      },
      {
        coachId: coachA,
        programId,
        startAt: at("2026-07-06", "09:00"),
        endAt: at("2026-07-06", "11:00"),
        ratePer30MinCents: WORK_RATE_PER_30_MIN,
        status: "posted",
        createdBy: adminId,
      },
      // HELD — never payable, so it must not reach a statement figure.
      {
        coachId: coachA,
        programId,
        startAt: at("2026-07-07", "09:00"),
        endAt: at("2026-07-07", "11:00"),
        ratePer30MinCents: 999_900,
        status: "held",
        createdBy: adminId,
      },
    ])
    .returning({ id: hourLogs.id });
  createdLogIds.push(...logs.map((r) => r.id));
});

afterAll(async () => {
  if (createdLogIds.length > 0) {
    await db.delete(hourLogs).where(inArray(hourLogs.id, createdLogIds));
  }
  if (programId) await db.delete(programs).where(eq(programs.id, programId));
  await truncateMutables();
});

beforeEach(async () => {
  await truncateMutables();
});

/* ── Fixture writers ──────────────────────────────────────────────────────── */

/** One cage booking. Hours are PFA wall clock; slots price it. */
async function cageSession(
  coachId: string,
  date: string,
  startTime: string,
  endTime: string,
): Promise<void> {
  await db.insert(sessionsBilling).values({
    coachId,
    resourceId: cageResourceId,
    startAt: at(date, startTime),
    endAt: at(date, endTime),
    ratePer30MinCents: CAGE_RATE_PER_30_MIN,
    createdBy: adminId,
  });
}

async function payment(opts: {
  coachId: string;
  amountCents: number;
  paidOn: string;
  /** null = "no period stated" — the load-bearing NULL (SPEC §4). */
  coversThrough: string | null;
  direction?: "coach_to_pfa" | "pfa_to_coach";
  status?: "pending" | "confirmed";
  reference?: string;
  deleted?: boolean;
}): Promise<void> {
  await db.insert(coachPayments).values({
    coachId: opts.coachId,
    amountCents: opts.amountCents,
    method: "zelle",
    direction: opts.direction ?? "coach_to_pfa",
    // Both date columns are stored at PFA midnight, the SAME convention
    // `buildInput` uses on the write path — two columns on one row disagreeing
    // about wall clock is how a month-boundary off-by-one gets in.
    paidAt: at(opts.paidOn, "00:00"),
    coversThrough:
      opts.coversThrough === null ? null : at(opts.coversThrough, "00:00"),
    reference: opts.reference ?? null,
    status: opts.status ?? "confirmed",
    recordedBy: adminId,
    deletedAt: opts.deleted ? new Date() : null,
  });
}

async function statementFor(
  coachId: string,
  p: NormalizedFilters,
) {
  const coaches = await fetchStatementCoaches({ coachIds: [coachId] });
  const coach = singleCoachInScope([coachId], coaches);
  if (!coach) throw new Error(`statementFor: no coach data for ${coachId}`);
  return buildStatementPair({
    coachName: coach.coachName,
    coachEmail: coach.coachEmail,
    period: { fromDate: p.fromDate, toDateExclusive: p.toDateExclusive },
    cageCharges: coach.cageCharges,
    workCharges: coach.workCharges,
    payments: coach.payments,
  });
}

/* ── 1. Alex Milone's real case, end to end from Postgres ─────────────────── */

describe("🔴 a payment PAID in August that COVERS July", () => {
  beforeEach(async () => {
    // June: 2h of cage = 4 slots × $22 = $88.00 → July's OPENING balance.
    await cageSession(coachA, "2026-06-10", "09:00", "11:00");
    // July: 15h of cage = 30 slots × $22 = $660.00 — the real figure.
    await cageSession(coachA, "2026-07-02", "09:00", "16:00"); // 14 slots
    await cageSession(coachA, "2026-07-09", "09:00", "16:00"); // 14 slots
    await cageSession(coachA, "2026-07-16", "09:00", "10:00"); // 2 slots
    await payment({
      coachId: coachA,
      amountCents: 66_000,
      paidOn: "2026-08-07",
      coversThrough: "2026-07-31",
      reference: "July 2026",
    });
  });

  it("lands on the JULY statement, not August's", async () => {
    const july = (await statementFor(coachA, JULY)).cage;
    expect(july.chargesCents).toBe(66_000);
    expect(july.paymentsCents).toBe(66_000);
    expect(july.paymentRows).toHaveLength(1);
    expect(july.paymentRows[0].coversThrough).toBe("Jul 31");
    // Paid-on is INFORMATION on the row — it is shown, and it placed nothing.
    expect(july.paymentRows[0].paidOn).toBe("Aug 07");
    expect(july.paymentRows[0].reference).toBe("July 2026");
  });

  it("is absent from AUGUST's payment rows", async () => {
    // The whole feature in one assertion: bucketing by `paidAt` would put this
    // row here and leave July showing $660 still outstanding.
    const august = (await statementFor(coachA, AUGUST)).cage;
    expect(august.paymentRows).toHaveLength(0);
    expect(august.paymentsCents).toBe(0);
  });

  it("carries an OPENING balance from charges before the period", async () => {
    // Only possible because the fetch is deliberately not period-filtered. A
    // pre-filtered fetch reports $0.00 opening for every coach, always.
    const july = (await statementFor(coachA, JULY)).cage;
    expect(july.openingCents).toBe(8_800);
    expect(july.closingCents).toBe(8_800 + 66_000 - 66_000);
  });

  it("settles the July balance as seen FROM August", async () => {
    // August's opening = all charges before Aug 1 ($88 + $660) minus all
    // payments covering before Aug 1 ($660) = $88.
    const august = (await statementFor(coachA, AUGUST)).cage;
    expect(august.openingCents).toBe(8_800);
  });

  it("shows June owing the $88 that July opens with", async () => {
    const june = (await statementFor(coachA, JUNE)).cage;
    expect(june.openingCents).toBe(0);
    expect(june.chargesCents).toBe(8_800);
    expect(june.closingCents).toBe(8_800);
  });
});

describe("🔴 the month boundary itself", () => {
  beforeEach(async () => {
    await cageSession(coachA, "2026-07-02", "09:00", "10:00"); // $44.00
  });

  it("coversThrough at the LAST instant of July belongs to July", async () => {
    await payment({
      coachId: coachA,
      amountCents: 4_400,
      paidOn: "2026-08-01",
      coversThrough: "2026-07-31",
    });
    expect((await statementFor(coachA, JULY)).cage.paymentsCents).toBe(4_400);
    expect((await statementFor(coachA, AUGUST)).cage.paymentsCents).toBe(0);
  });

  it("coversThrough at PFA-midnight on Aug 1 belongs to AUGUST", async () => {
    // `toDateExclusive` is half-open: `covers === toDateExclusive` is the NEXT
    // period. Written through Postgres so the stored instant — not a JS Date
    // that never left the process — is what is being classified.
    await payment({
      coachId: coachA,
      amountCents: 4_400,
      paidOn: "2026-08-01",
      coversThrough: "2026-08-01",
    });
    expect((await statementFor(coachA, JULY)).cage.paymentsCents).toBe(0);
    expect((await statementFor(coachA, AUGUST)).cage.paymentsCents).toBe(4_400);
  });

  it("coversThrough on Jun 30 is July's OPENING, not July's payments", async () => {
    await payment({
      coachId: coachA,
      amountCents: 4_400,
      paidOn: "2026-08-01",
      coversThrough: "2026-06-30",
    });
    const july = (await statementFor(coachA, JULY)).cage;
    expect(july.paymentsCents).toBe(0);
    expect(july.openingCents).toBe(-4_400);
  });
});

/* ── 2. Untagged, pending and deleted money ──────────────────────────────── */

describe("payments the statement must not place in a period", () => {
  beforeEach(async () => {
    await cageSession(coachA, "2026-07-02", "09:00", "10:00"); // $44.00
  });

  it("a NULL coversThrough is unapplied — in NO period", async () => {
    await payment({
      coachId: coachA,
      amountCents: 17_000,
      paidOn: "2026-07-15",
      coversThrough: null,
    });
    const july = (await statementFor(coachA, JULY)).cage;
    expect(july.unappliedCents).toBe(17_000);
    expect(july.paymentsCents).toBe(0);
    expect(july.paymentRows).toHaveLength(0);
    expect(july.closingCents).toBe(4_400);
  });

  it("a PENDING payment is shown but never summed", async () => {
    await payment({
      coachId: coachA,
      amountCents: 4_400,
      paidOn: "2026-07-20",
      coversThrough: "2026-07-31",
      status: "pending",
    });
    const july = (await statementFor(coachA, JULY)).cage;
    expect(july.paymentRows).toHaveLength(1);
    expect(july.paymentRows[0].pending).toBe(true);
    expect(july.paymentsCents).toBe(0);
    expect(july.closingCents).toBe(4_400);
  });

  it("a SOFT-DELETED payment is gone from figures AND from display", async () => {
    // The fetch deliberately returns deleted rows so the engine is the single
    // place that decides — this proves the decision still happens.
    await payment({
      coachId: coachA,
      amountCents: 4_400,
      paidOn: "2026-07-20",
      coversThrough: "2026-07-31",
      deleted: true,
    });
    const july = (await statementFor(coachA, JULY)).cage;
    expect(july.paymentRows).toHaveLength(0);
    expect(july.paymentsCents).toBe(0);
    expect(july.unappliedCents).toBe(0);
  });

  it("a WRONG-DIRECTION payment stays on the other account", async () => {
    // Cage charges are never paid down by a payout. The statement must not
    // infer around a mis-tagged direction (SPEC §10).
    await payment({
      coachId: coachA,
      amountCents: 4_400,
      paidOn: "2026-07-20",
      coversThrough: "2026-07-31",
      direction: "pfa_to_coach",
    });
    const pair = await statementFor(coachA, JULY);
    expect(pair.cage.paymentsCents).toBe(0);
    expect(pair.work.paymentsCents).toBe(4_400);
  });
});

/* ── 3. One coach vs many (SPEC §8.1) ────────────────────────────────────── */

describe("scope — one coach gets a statement, zero or many get the roll-up", () => {
  beforeEach(async () => {
    await cageSession(coachA, "2026-07-02", "09:00", "10:00"); // $44.00
    await cageSession(coachB, "2026-07-03", "09:00", "10:00"); // $44.00
  });

  it("ONE coach in scope resolves to that coach", async () => {
    const coaches = await fetchStatementCoaches({ coachIds: [coachA] });
    expect(coaches).toHaveLength(1);
    expect(singleCoachInScope([coachA], coaches)?.coachId).toBe(coachA);
  });

  it("TWO coaches in scope resolve to NO single coach → the roster", async () => {
    const coaches = await fetchStatementCoaches({
      coachIds: [coachA, coachB],
    });
    expect(coaches).toHaveLength(2);
    expect(singleCoachInScope([coachA, coachB], coaches)).toBeNull();
  });

  it("NO coach filter resolves to the roster, with every active coach in it", async () => {
    const coaches = await fetchStatementCoaches({ coachIds: [] });
    expect(singleCoachInScope([], coaches)).toBeNull();
    expect(coaches.map((c) => c.coachId)).toContain(coachA);
    expect(coaches.map((c) => c.coachId)).toContain(coachB);
  });

  it("a coach with NO history still gets a statement when asked for by name", async () => {
    await truncateMutables();
    const coaches = await fetchStatementCoaches({ coachIds: [coachB] });
    const coach = singleCoachInScope([coachB], coaches);
    expect(coach).not.toBeNull();
    expect(coach?.cageCharges).toEqual([]);
    // hour_logs are not truncated, but coachB has none in this file.
    expect(coach?.payments).toEqual([]);
  });

  it("an unknown coach id yields no statement rather than a document about nobody", async () => {
    const coaches = await fetchStatementCoaches({
      coachIds: ["not-a-user-id"],
    });
    expect(coaches).toEqual([]);
    expect(singleCoachInScope(["not-a-user-id"], coaches)).toBeNull();
  });

  it("roster rows agree with the statements they link to", async () => {
    // Each row is built by running the SAME pair the row's own statement
    // renders, so a roster figure can never disagree with its document.
    const coaches = await fetchStatementCoaches({ coachIds: [] });
    const rows = buildStatementRoster({
      period: { fromDate: JULY.fromDate, toDateExclusive: JULY.toDateExclusive },
      coaches,
    });
    for (const id of [coachA, coachB]) {
      const row = rows.find((r) => r.coachId === id);
      const pair = await statementFor(id, JULY);
      expect(row?.cageBalanceCents).toBe(pair.cage.closingCents);
      expect(row?.workBalanceCents).toBe(pair.work.closingCents);
    }
  });

  it("🔴 the roster never exposes a combined total", async () => {
    const coaches = await fetchStatementCoaches({ coachIds: [] });
    const rows = buildStatementRoster({
      period: { fromDate: JULY.fromDate, toDateExclusive: JULY.toDateExclusive },
      coaches,
    });
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "cageBalanceCents",
        "coachId",
        "coachName",
        "unappliedCents",
        "workBalanceCents",
      ]);
    }
  });
});

/* ── 4. The work account agrees with the Work hours tab (SPEC §10) ───────── */

describe("the work statement quotes the SAME total as ?tab=work", () => {
  it("for the same coach and the same period", async () => {
    const statement = (await statementFor(coachA, JULY)).work;

    const workTabRows = await fetchHourLogRowsWithScheduleNotes(
      hourLogFiltersFromReportFilters({
        ...JULY,
        coachIds: [coachA],
        programId: undefined,
      }),
    );
    const workTab = buildWorkReport(workTabRows);

    // 2h at $30/hr on Jul 6.
    expect(statement.chargesCents).toBe(6_000);
    expect(statement.chargesCents).toBe(workTab.grandTotalCents);
  });

  it("excludes the HELD log from both, identically", async () => {
    const statement = (await statementFor(coachA, JULY)).work;
    expect(
      statement.chargeRows.every((r) => r.amountCents < 999_900),
    ).toBe(true);
  });

  it("opens July with June's posted work", async () => {
    const statement = (await statementFor(coachA, JULY)).work;
    expect(statement.openingCents).toBe(6_000);
  });

  it("carries the payout caveat and the posted-only note", async () => {
    // SPEC §11 — mandatory on the work account, in the document. Never on the
    // cage account, whose charges and payments both live in the app.
    const pair = await statementFor(coachA, JULY);
    expect(pair.work.caveat).not.toBeNull();
    expect(pair.work.scopeNote).not.toBeNull();
    expect(pair.cage.caveat).toBeNull();
    expect(pair.cage.scopeNote).toBeNull();
  });
});

/* ── 5. Reconciliation to the all-time figure (SPEC §7) ──────────────────── */

describe("the statement reconciles to netCoachLedgers", () => {
  beforeEach(async () => {
    await cageSession(coachA, "2026-06-10", "09:00", "11:00"); // $88.00 before
    await cageSession(coachA, "2026-07-02", "09:00", "10:00"); // $44.00 in
    await cageSession(coachA, "2026-09-05", "09:00", "10:00"); // $44.00 after
    await payment({
      coachId: coachA,
      amountCents: 4_400,
      paidOn: "2026-08-07",
      coversThrough: "2026-07-31",
    });
    await payment({
      coachId: coachA,
      amountCents: 1_000,
      paidOn: "2026-08-07",
      coversThrough: null,
    });
  });

  it("closing + charges after − payments after − unapplied = current", async () => {
    const cage = (await statementFor(coachA, JULY)).cage;
    expect(
      cage.closingCents +
        cage.chargesAfterCents -
        cage.paymentsCoveringAfterCents -
        cage.unappliedCents,
    ).toBe(cage.currentBalanceCents);
  });

  it("the current balance is the SAME number /admin/payments shows", async () => {
    // Computed here a second, independent way from the raw rows, so the
    // assertion is not the engine agreeing with itself.
    const cage = (await statementFor(coachA, JULY)).cage;
    const rows = await db
      .select({
        amountCents: coachPayments.amountCents,
        direction: coachPayments.direction,
        status: coachPayments.status,
        deletedAt: coachPayments.deletedAt,
      })
      .from(coachPayments)
      .where(eq(coachPayments.coachId, coachA));
    const owedAllTime = 8_800 + 4_400 + 4_400;
    const ledgers = netCoachLedgers(
      owedAllTime,
      0,
      rows
        .filter((r) => r.deletedAt === null && r.status === "confirmed")
        .map((r) => ({ amountCents: r.amountCents, direction: r.direction })),
    );
    expect(cage.currentBalanceCents).toBe(ledgers.cageBalanceCents);
  });

  it("itemizes what is outside the period rather than hiding it", async () => {
    const cage = (await statementFor(coachA, JULY)).cage;
    expect(cage.chargesAfterCents).toBe(4_400);
    expect(cage.unappliedCents).toBe(1_000);
  });
});

/* ── 6. The shared filter contract (SPEC §10 / §13 Phase C) ──────────────── */

describe("🔴 the four tabs and the download route still behave", () => {
  it("an Apply-filters submit lands each tab on ITSELF", () => {
    // The form carries `tab` on its submit BUTTONS (`name="tab"`), so an Apply
    // from tab X produces `?…&tab=X`. Both parsers the page runs on that URL
    // must agree: the tab resolves to X and the FILTERS are untouched by it.
    const base =
      "from=2026-07-01&to=2026-07-31&coachIds=c1&resourceTypes=cage&programId=p1";
    const plain = filtersFromURLSearchParams(new URLSearchParams(base));
    for (const tab of REPORT_TABS) {
      const sp = new URLSearchParams(`${base}&tab=${tab}`);
      expect(normalizeReportTab(sp.get("tab") ?? undefined)).toBe(tab);
      expect(filtersFromURLSearchParams(sp)).toEqual(plain);
    }
  });

  it("the See-statement submit lands on Statements from any tab", () => {
    expect(normalizeReportTab("statements")).toBe("statements");
  });

  it("the download route is unaffected by tab OR account", () => {
    // A workbook always spans every category (reports-tabs SPEC §5). If either
    // key could reach `NormalizedFilters`, a money export could be silently
    // narrowed to one direction while its filename still claimed the range.
    const bare = filtersFromURLSearchParams(
      new URLSearchParams("from=2026-07-01&to=2026-07-31&coachIds=c1"),
    );
    const decorated = filtersFromURLSearchParams(
      new URLSearchParams(
        "from=2026-07-01&to=2026-07-31&coachIds=c1&tab=statements&account=work",
      ),
    );
    expect(decorated).toEqual(bare);
  });

  it("the account switcher never leaks into the filters it round-trips", () => {
    // Follow the real link the switcher emits back through the real parser.
    const filters = normalizeFilters({
      from: "2026-07-01",
      to: "2026-07-31",
      coachIds: ["c1"],
      resourceTypes: ["cage"],
      programId: "p1",
    });
    for (const account of ["cage", "work"] as const) {
      const href = statementHref(filters, account);
      const sp = new URLSearchParams(href.slice(href.indexOf("?") + 1));
      expect(normalizeStatementAccount(sp.get("account") ?? undefined)).toBe(account);
      expect(normalizeReportTab(sp.get("tab") ?? undefined)).toBe("statements");
      // Same filters back out, with no trace of the account in them.
      expect(filtersFromURLSearchParams(sp)).toEqual(filters);
      expect(Object.keys(filtersFromURLSearchParams(sp))).not.toContain(
        "account",
      );
    }
  });
});
