// Integration tests for src/lib/payments/history-fetch.ts — the read behind
// the "Payment history" list on /admin/payments (payments-load-more SPEC
// §7.2). Hits the real Neon dev branch.
//
// What is pinned here is the ORDER and the COUNT, because the list's "show
// more" control depends on both: the first N rows must be the same N rows on
// every load, and the count must be every payment the list could show.
//
// Fixture discipline:
//   - `fetchPaymentHistory` scans the WHOLE coach_payments table, so these
//     tests have to own the whole table. coach_payments is in
//     truncateMutables; the first test asserts the table really is empty
//     rather than assuming it (CI seeds the branch, a local run does not).
//   - Payments are created ONLY through createPaymentInternal, and every
//     assertion is against the ids those calls RETURNED — never against a
//     second read used as an oracle.
//   - Same-day payments are created one at a time (each awaited), so each
//     gets its own recorded_at, the way Mark entering a batch does.
//   - `paidAt` is built the way the form builds it: PFA midnight of the day.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPaymentInternal,
  deletePaymentInternal,
} from "@/lib/server/payment-actions";
import { fetchPaymentHistory } from "@/lib/payments/history-fetch";
import { parsePfaInput } from "@/lib/timezone";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

let fixtures: FixtureUsers;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

/** PFA midnight of `day` — exactly what form-actions.ts stores as paid_at. */
function paidOn(day: string): Date {
  return parsePfaInput(day, "00:00");
}

// One payment for the fixture coach. The amount is caller-chosen so a failing
// assertion can be traced back to the row that caused it.
async function createPayment(
  day: string,
  amountCents: number,
  options?: { status?: "pending" | "confirmed" },
) {
  return createPaymentInternal(
    fixtures.admin,
    {
      coachId: fixtures.coach.id,
      amountCents,
      method: "zelle" as const,
      paidAt: paidOn(day),
    },
    options,
  );
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id);
}

describe("fetchPaymentHistory", () => {
  it("same-day order is deterministic: newest-entered first, identical on every read", async () => {
    // The table must start empty — this fetch has no coach or date filter, so
    // a stray row from anywhere would be counted.
    const empty = await fetchPaymentHistory(100);
    expect(empty.rows).toEqual([]);
    expect(empty.count).toBe(0);

    // Six payments for ONE day: all six share the identical paid_at.
    const created: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const payment = await createPayment("2026-08-10", i * 100);
      created.push(payment.id);
    }
    const newestEnteredFirst = [...created].reverse();

    for (let read = 1; read <= 10; read++) {
      const result = await fetchPaymentHistory(100);
      expect(ids(result.rows), `read ${read}`).toEqual(newestEnteredFirst);
      expect(result.count, `read ${read}`).toBe(6);
    }

    // The join carries the coach's name and email onto every row.
    const { rows } = await fetchPaymentHistory(100);
    for (const row of rows) {
      expect(row.coachId).toBe(fixtures.coach.id);
      expect(row.coachName).toBe(fixtures.coach.name);
      expect(row.coachEmail).toBe(fixtures.coach.email);
      expect(row.paidAt.getTime()).toBe(paidOn("2026-08-10").getTime());
    }
  });

  it("THE PREFIX PROPERTY: a smaller limit is exactly the start of a larger one", async () => {
    // Six rows on Aug 10 interleaved with three on Aug 11, so neither
    // insertion order nor its reverse is the right answer — only
    // (paid day, then entry time) is.
    const plan: Array<["A" | "B", string]> = [
      ["A", "2026-08-10"],
      ["B", "2026-08-11"],
      ["A", "2026-08-10"],
      ["A", "2026-08-10"],
      ["B", "2026-08-11"],
      ["A", "2026-08-10"],
      ["A", "2026-08-10"],
      ["B", "2026-08-11"],
      ["A", "2026-08-10"],
    ];
    const dayA: string[] = [];
    const dayB: string[] = [];
    for (const [index, [group, day]] of plan.entries()) {
      const payment = await createPayment(day, (index + 1) * 100);
      (group === "A" ? dayA : dayB).push(payment.id);
    }
    expect(dayA).toHaveLength(6);
    expect(dayB).toHaveLength(3);

    // Newer day first; inside each day, newest-entered first.
    const expected = [...dayB].reverse().concat([...dayA].reverse());

    const full = await fetchPaymentHistory(9);
    expect(ids(full.rows)).toEqual(expected);
    expect(full.count).toBe(9);

    // The headline case: a cut of 6 lands INSIDE the Aug 10 tie (3 rows of
    // Aug 11, then 3 of the 6 same-day rows). "Show more" from 6 to 9 must
    // not move those first 6.
    const firstSix = await fetchPaymentHistory(6);
    expect(ids(firstSix.rows)).toEqual(ids(full.rows).slice(0, 6));
    expect(ids(firstSix.rows).slice(3)).toEqual([...dayA].reverse().slice(0, 3));

    // And it holds at every cut, not only that one.
    for (let limit = 1; limit <= 9; limit++) {
      const cut = await fetchPaymentHistory(limit);
      expect(ids(cut.rows), `limit ${limit}`).toEqual(
        expected.slice(0, limit),
      );
      expect(cut.count, `limit ${limit}`).toBe(9);
    }
  });

  it("newest PAID day first, and a back-dated payment entered last sorts by its paid date", async () => {
    const aug10 = await createPayment("2026-08-10", 1000);
    const aug12 = await createPayment("2026-08-12", 1200);
    // Entered last (so it has the newest recorded_at), but paid in June.
    const backDated = await createPayment("2026-06-20", 620);

    const { rows, count } = await fetchPaymentHistory(100);
    expect(ids(rows)).toEqual([aug12.id, aug10.id, backDated.id]);
    expect(count).toBe(3);

    // It is the most recently entered row, and it is still last.
    const newestEntry = Math.max(...rows.map((r) => r.recordedAt.getTime()));
    expect(rows[2].recordedAt.getTime()).toBe(newestEntry);
    expect(rows[2].paidAt.getTime()).toBe(paidOn("2026-06-20").getTime());
  });

  it("a soft-deleted payment is in neither the rows nor the count", async () => {
    const first = await createPayment("2026-08-10", 100);
    const doomed = await createPayment("2026-08-10", 200);
    const third = await createPayment("2026-08-10", 300);

    // Positive control: before the delete the row IS there and IS counted.
    const before = await fetchPaymentHistory(100);
    expect(before.count).toBe(3);
    expect(ids(before.rows)).toEqual([third.id, doomed.id, first.id]);

    await deletePaymentInternal(fixtures.admin, doomed.id);

    const after = await fetchPaymentHistory(100);
    expect(after.count).toBe(2);
    expect(ids(after.rows)).toEqual([third.id, first.id]);
    expect(ids(after.rows)).not.toContain(doomed.id);
  });

  it("pending payments ARE included, in the rows and in the count", async () => {
    const confirmed = await createPayment("2026-08-10", 100);
    const pending = await createPayment("2026-08-11", 200, {
      status: "pending",
    });
    expect(confirmed.status).toBe("confirmed");
    expect(pending.status).toBe("pending");

    const { rows, count } = await fetchPaymentHistory(100);
    expect(count).toBe(2);
    expect(ids(rows)).toEqual([pending.id, confirmed.id]);
    expect(rows.map((r) => r.status)).toEqual(["pending", "confirmed"]);
  });

  it("count does not depend on limit; rows.length is min(limit, count)", async () => {
    const created: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const payment = await createPayment("2026-08-10", i * 100);
      created.push(payment.id);
    }
    const expected = [...created].reverse();

    for (const limit of [1, 2, 4, 5, 6, 100]) {
      const { rows, count } = await fetchPaymentHistory(limit);
      expect(count, `limit ${limit}`).toBe(5);
      expect(rows.length, `limit ${limit}`).toBe(Math.min(limit, 5));
      expect(ids(rows), `limit ${limit}`).toEqual(expected.slice(0, limit));
    }
  });
});
