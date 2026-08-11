// payment-statement SPEC §8 — the Statements tab when MORE THAN ONE coach is in
// scope.
//
// Reaching the tab from the Reports filter bar means the usual case is "all
// coaches, one month", not one coach. That is not a degraded statement view —
// it is the job Mark opens Reports to do: decide who owes him and who he owes.
// And it is the one thing no screen in this app does today: /admin/reports is
// ranged but GROSS, /admin/payments and the coach page are netted but ALL-TIME.
// This roll-up is ranged AND netted, per account, which is the whole feature.
//
// 🔴 Two balance columns, never a third that adds them. The directions are
// opposite (coach→PFA vs PFA→coach) and this codebase forbids summing them in
// three separate places. Column HEADERS carry the direction in words so a
// printed or screenshotted row can't lose it.

// ── Print ────────────────────────────────────────────────────────────────────
// 🔴 Phase D. Before this, `PrintDocumentMode` mounted ONLY inside
// `StatementCard`, so a Cmd+P on the roll-up printed the whole app: the nav
// ("Home · Rentals · Work Log · Attendance · Billing & Records"), the sign-out
// button, the filter bar, the tab strip, the footer credit, and the warm
// `bg-page` wash as a grey band. Verified by rendering this page to PDF and
// reading it — nothing on screen showed it, and every assertion was green.
//
// It is fixed rather than documented because SPEC §13 calls a roster print
// "Phase D scope" and a genuinely useful monthly artifact: one page saying who
// owes PFA and who PFA owes for a month is the single sheet Mark actually works
// from, and it is the one view in this feature that is about the whole roster.
// So the roll-up opts into the same `printing-document` rules the statement
// uses, and the only things marked screen-only are the print button itself and
// the per-row `Statement →` links, which are dead affordances on paper.
import Link from "next/link";
import { AlertTriangle, ArrowRight, Printer } from "lucide-react";
import { formatDollarsExact } from "@/lib/format-money";
import { ClientPrintButton, PrintDocumentMode } from "./client-print-button";
// The row shape is the ENGINE's output, not this component's invention — it was
// declared in both places during the design mock, which is how a column's
// meaning ("all time" vs "in range") gets to disagree with itself. One
// declaration, in the contract module both sides can import.
import type { StatementRosterEntry } from "@/lib/statement/types";

export function StatementRoster({
  rows,
  periodLabel,
  hrefForCoach,
}: {
  rows: StatementRosterEntry[];
  periodLabel: string;
  hrefForCoach: (coachId: string) => string;
}) {
  const totalUnapplied = rows.reduce((n, r) => n + r.unappliedCents, 0);

  // 🔴 A BALANCE'S SIGN CAN FLIP, AND THE GLANCE STATS HAVE TO FOLLOW IT.
  //
  // These read `> 0` on one column each, and that shipped WRONG in a case SPEC
  // §11 explicitly says is real: Mark pays coaches outside the app, so a
  // recorded payout can exceed the logged work and `workBalanceCents` goes
  // NEGATIVE. That coach owes PFA — but with the old predicates he appeared in
  // NEITHER stat, while his row printed `($40.00)` under a header reading "PFA
  // owes coach". The most available reading of that cell was "PFA owes $40",
  // i.e. pay him again.
  //
  // So the rule is the one `engine.ts`'s `directionLabel` already applies on
  // the single-coach card (`closingCents >= 0` on cage, `< 0` on work), and the
  // roll-up must not contradict the document it links to:
  //
  //   · cage > 0  → coach owes PFA        · cage < 0  → PFA owes the coach
  //   · work > 0  → PFA owes the coach    · work < 0  → the coach owes PFA
  //
  // ⚠️ The two counts deliberately OVERLAP rather than partition. A coach who
  // rents cages and is also owed for work belongs in both sentences, and both
  // are true about him; forcing him into one would need a combined total to
  // decide which, and there is no such figure (§11). What the pair guarantees
  // instead is COVERAGE: every row with a non-zero balance in either column
  // lands in at least one stat, which is exactly the property that was broken.
  // Pinned by a test rather than left to reading.
  const owingCount = rows.filter(
    (r) => r.cageBalanceCents > 0 || r.workBalanceCents < 0,
  ).length;
  const owedCount = rows.filter(
    (r) => r.workBalanceCents > 0 || r.cageBalanceCents < 0,
  ).length;

  return (
    <section className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-5 print:rounded-none print:border-0 print:p-0 print:shadow-none">
      <PrintDocumentMode />

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">
            Statements — {periodLabel}
          </h2>
          <p className="mt-0.5 text-xs text-fg-subtle">
            Where each coach stands at the end of this period: charges in the
            period, minus payments that <em>cover</em> the period. Open one to
            read or print its statement.
          </p>
        </div>
        {/* The button is chrome; the table it prints is the document. */}
        <div data-print-hide>
          <ClientPrintButton>
            <Printer className="h-3.5 w-3.5" />
            Print roster
          </ClientPrintButton>
        </div>
      </div>

      <dl className="mb-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        {/* Each hint names the FLIPPED half, because that is the half a reader
            would not guess from the label. */}
        <Stat
          label="Coaches owing PFA"
          value={String(owingCount)}
          hint="Cage rent still due, or overpaid for work"
        />
        <Stat
          label="Coaches PFA owes"
          value={String(owedCount)}
          hint="Work pay still due, or paid cage rent ahead"
        />
        {/* 🔴 NOT "Payments with no period stated" — that is the STATEMENT's
            line, and it means one account. This figure sums BOTH directions
            (engine.ts: `cage.unappliedCents + work.unappliedCents`) and then
            sums that across every coach in scope, so it is normally the largest
            of the three. Sharing the statement's six words made Alex Milone
            read $210 here, $170 on his cage statement and $40 on his work
            statement — one label, three values, one click apart. */}
        <Stat
          label="Untagged payments"
          value={formatDollarsExact(totalUnapplied)}
          hint={
            totalUnapplied > 0
              ? "All coaches, both directions, all time — counted in no period"
              : "All coaches, both directions, all time"
          }
        />
      </dl>

      {/* SPEC §11 — the caveat has to ride on THIS surface too. The individual
          work statement carries it, but this table shows the same payout
          figures for the whole roster at once, so omitting it here would be the
          exact "symmetrical and silent" failure §11 forbids. */}
      <p className="mb-3 flex gap-2.5 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>
          <span className="font-medium">Work pay is what the logged work is
          worth — not what is still owed.</span>{" "}
          PFA pays coaches outside this system, so any payout that was never
          recorded here is not subtracted. The cage-rental column has no such
          gap: those charges and payments both live in the app.
        </span>
      </p>

      {/* `print-flow` releases the scroll container in print — a clipped table
          is a clipped money figure, and a clipped column header is a lost
          direction (the 40bf31c defect). */}
      <div className="print-flow overflow-x-auto rounded-lg border border-line">
        <table className="print-flow w-full min-w-[640px] text-sm">
          <thead className="border-b border-line bg-surface-2/50 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 text-left">
                Coach
              </th>
              {/* Direction in the HEADER, in words. */}
              <th scope="col" className="px-3 py-2 text-right">
                Cage rentals
                <span className="block font-normal normal-case tracking-normal text-fg-subtle">
                  coach owes PFA
                </span>
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                Work pay
                <span className="block font-normal normal-case tracking-normal text-fg-subtle">
                  PFA owes coach
                </span>
              </th>
              {/* Deliberately NOT the statement's "Payments with no period
                  stated": see the glance stat above. The sub-caption carries
                  BOTH scopes because a printed or screenshotted row loses the
                  footnote, and "all time" alone was the half a reader already
                  had — "both directions" is the half that explains why this
                  number is bigger than the one on the statement. */}
              <th scope="col" className="px-3 py-2 text-right">
                Untagged payments
                <span className="block font-normal normal-case tracking-normal text-fg-subtle">
                  all time · both directions
                </span>
              </th>
              <th data-print-hide scope="col" className="px-3 py-2 text-right">
                <span className="sr-only">Statement</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.coachId}
                className="border-b border-line/60 last:border-0 hover:bg-surface-2/40"
              >
                <td className="px-3 py-2.5 font-medium">{row.coachName}</td>
                <Money cents={row.cageBalanceCents} />
                <Money cents={row.workBalanceCents} />
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {row.unappliedCents > 0 ? (
                    <span className="text-warning">
                      {formatDollarsExact(row.unappliedCents)}
                    </span>
                  ) : (
                    <span className="text-fg-disabled">—</span>
                  )}
                </td>
                <td data-print-hide className="px-3 py-2.5 text-right">
                  <Link
                    href={hrefForCoach(row.coachId)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
                  >
                    Statement
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The reconciling footnote. Two jobs, both of them corrections:
          (1) parentheses had a rule for the CAGE column only, under a WORK
          header that reads "PFA owes coach" — so `($40.00)` there was most
          readably "PFA owes $40", when it means the opposite; and (2) the
          untagged figure is a different SCOPE from the statement's line, and a
          reader who notices the two numbers disagree needs to be told why here
          rather than concluding one of them is wrong. */}
      <p className="mt-3 max-w-3xl text-[11px] leading-relaxed text-fg-subtle">
        The two balance columns run in opposite directions and are never added
        together.{" "}
        <span className="font-medium">
          A figure in parentheses runs the OTHER way than its column header
        </span>{" "}
        — in <span className="font-medium">Cage rentals</span>, ($40.00) means
        PFA owes that coach $40, because he paid ahead; in{" "}
        <span className="font-medium">Work pay</span>, ($40.00) means that coach
        owes PFA $40, because he was paid more than his logged work is worth. A
        coach with money running each way is counted in both stats above.
        <br />
        <span className="font-medium">Untagged payments</span> is all-time and
        spans <span className="font-medium">both directions at once</span>, so
        it is normally <span className="font-medium">larger</span> than the
        &ldquo;Payments with no period stated&rdquo; figure on any one statement,
        which covers a single account. A payment with no coverage date belongs to
        no period at all, which is why it needs one.
      </p>
    </section>
  );
}

function Money({ cents }: { cents: number }) {
  if (cents === 0) {
    return (
      <td className="px-3 py-2.5 text-right tabular-nums text-fg-disabled">
        —
      </td>
    );
  }
  // Accounting convention for a credit: parentheses, not a minus sign. Mark
  // reads statements; a bare "-$40.00" on a balance column is ambiguous about
  // WHICH way it went, and parentheses are the convention he already knows.
  const credit = cents < 0;
  return (
    <td
      className={[
        "px-3 py-2.5 text-right tabular-nums",
        credit ? "text-fg-muted" : "font-medium",
      ].join(" ")}
    >
      {credit
        ? `(${formatDollarsExact(Math.abs(cents))})`
        : formatDollarsExact(cents)}
    </td>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums tracking-tight">
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-[11px] text-fg-subtle">{hint}</p> : null}
    </div>
  );
}
