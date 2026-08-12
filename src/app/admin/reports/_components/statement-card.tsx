// payment-statement SPEC §5 — the per-coach STATEMENT.
//
// Presentational only. It receives a fully-computed `StatementPair` and renders
// it; it does no fetching, no netting and no money math beyond laying out the
// figures the engine already produced. That split is deliberate: the arithmetic
// is the part that has to be tested, and it cannot be tested through JSX.
//
// ── Why it looks like a credit-card statement ────────────────────────────────
// Mark reads Citi statements closely, so the conventions he already holds are
// the cheapest possible documentation: previous balance → new charges →
// payments & credits → new balance, with the arithmetic laid out as a column he
// can add up himself. Anything that deviates from that reads as an error.
//
// ── Why two accounts and a switcher, not one merged view ─────────────────────
// Cage rentals (coach owes PFA) and work pay (PFA owes coach) are opposite
// directions, and this codebase forbids summing them in three separate places
// (payment-ledger.ts's header, ReportPreview's GrandTotal, reports-tabs §7).
// A credit-card statement has exactly ONE balance direction; two opposing
// ledgers is not a statement concept at all — the real-world analogue is
// holding two ACCOUNTS at one bank, where you pick an account and read its
// statement. So: a switcher, plus a header naming both balances with their
// directions spelled out in words. The switcher is not styling — it makes a
// combined total structurally unavailable, because the two are never on screen
// together to be added.
//
// 🔴 There is no combined total anywhere in this file, and there must never be.
//
// ── Print ────────────────────────────────────────────────────────────────────
// Print is the delivery mechanism (SPEC §9, Jacob 2026-08-10: print is enough,
// no app-sent email). App chrome — here AND in AppShell — is marked
// `data-print-hide` and dropped by the `@media print` block in globals.css,
// which is itself scoped to a `printing-document` body class so no other page's
// printing changes. The charge detail is always expanded so it cannot print as
// an empty section, and the document re-states coach + period + DIRECTION at the
// top so a printed page that outlives its context still says who owes whom.
//
// 🔴 All three of those rules exist because the FIRST print of this mock got
// them wrong: the whole app nav printed, the direction label clipped at the
// right page edge, and `break-inside-avoid` on a long section left page 1 half
// empty. None of that was visible on screen — it took rendering a PDF and
// looking at it, which is this file's own standing lesson about money surfaces.

import { AlertTriangle, Printer } from "lucide-react";
import Link from "next/link";
import { formatDollarsExact } from "@/lib/format-money";
import { CAGE_SLOT_EXPLAINER } from "@/lib/reports/rate-display";
import {
  STATEMENT_ACCOUNTS,
  statementAccountLabel,
  type Statement,
  type StatementAccount,
  type StatementPair,
} from "@/lib/statement/types";
import { ClientPrintButton, PrintDocumentMode } from "./client-print-button";

export function StatementCard({
  pair,
  account,
  hrefForAccount,
  periodChips,
}: {
  pair: StatementPair;
  account: StatementAccount;
  /** Builds the href for an account tab, preserving the current period. */
  hrefForAccount: (account: StatementAccount) => string;
  /** Month presets over the from/to (SPEC §6). Empty = hide the control. */
  periodChips?: { label: string; href: string; active: boolean }[];
}) {
  const statement = account === "cage" ? pair.cage : pair.work;

  return (
    <section className="my-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] print:my-0 print:rounded-none print:border-0 print:shadow-none">
      <PrintDocumentMode />

      {/* ── App chrome: never printed ───────────────────────────────── */}
      <div data-print-hide className="p-5 pb-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight">
              Statement
            </h2>
            <p className="text-xs text-fg-subtle mt-0.5">
              What this coach owed and paid over a chosen period. Charges are
              counted by when they happened; payments by the period they cover.
            </p>
          </div>
          <PrintButton />
        </div>

        {/* 🔴 THE PERIOD COMES FIRST — SPEC §2 rule 2, "one period, stated
            once, AT THE TOP", and the §5.0 mock puts this line above the two
            balances for the same reason.

            It shipped below them: the masthead that states the period sits
            inside the document, under the switcher and the chips, so this block
            opened with "Work pay · PFA owes Alex Milone · $660.00" and the
            nearest date was three controls away. A dated balance with no date
            near it is the one thing a statement reader will not tolerate, and it
            is a PAYOUT figure on the work account — §11's most expensive
            mistake. Screen-only (`data-print-hide` on the wrapper), so this
            never reached paper; the printed masthead was always correct. */}
        <p className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Statement period
          </span>
          <span className="text-sm font-medium tabular-nums">
            {pair.periodLabel}
          </span>
        </p>

        {/* Both balances, each with its direction in words. This is the
            "clear on who paid who in the same area" half of the design —
            and there is deliberately no total beneath them. */}
        <dl className="mt-2 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
          {STATEMENT_ACCOUNTS.map((key) => {
            const s = key === "cage" ? pair.cage : pair.work;
            return (
              <div
                key={key}
                className={[
                  "bg-surface px-4 py-3",
                  key === account ? "" : "opacity-70",
                ].join(" ")}
              >
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                  {statementAccountLabel(key)}
                </dt>
                <dd className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="text-xs text-fg-subtle">
                    {s.directionLabel}
                    {/* And each cell carries its own "as of", so the figure is
                        still dated if the line above it scrolls away or a
                        screenshot crops it — the same reason the printed
                        masthead repeats on page 2. */}
                    <span className="mt-0.5 block text-[10px] text-fg-muted">
                      as of {pair.periodEndShort}
                    </span>
                  </span>
                  <span className="text-lg font-semibold tabular-nums tracking-tight">
                    {formatDollarsExact(Math.abs(s.closingCents))}
                    <CreditBadge cents={s.closingCents} />
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="mt-2 text-[11px] text-fg-subtle">
          Two separate accounts, in opposite directions. They are never
          combined into one total.
        </p>

        {/* Account switcher — mirrors reports-tabs.tsx (gold underline,
            aria-current, focus ring), switching a query param rather than a
            route so the period above survives the change. */}
        <nav aria-label="Statement account" className="mt-5 border-b border-line">
          <ul className="-mb-px flex gap-1 overflow-x-auto whitespace-nowrap">
            {STATEMENT_ACCOUNTS.map((key) => {
              const isActive = key === account;
              return (
                <li key={key}>
                  <Link
                    href={hrefForAccount(key)}
                    aria-current={isActive ? "page" : undefined}
                    className={[
                      "inline-flex items-center rounded-sm border-b-2 px-3 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold sm:px-4",
                      isActive
                        ? "border-gold text-fg font-semibold"
                        : "border-transparent text-fg-muted font-medium hover:text-fg",
                    ].join(" ")}
                  >
                    {statementAccountLabel(key)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {periodChips && periodChips.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              Period
            </span>
            {periodChips.map((chip) => (
              <Link
                key={chip.label}
                href={chip.href}
                aria-current={chip.active ? "true" : undefined}
                className={[
                  "inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold",
                  chip.active
                    ? "border-gold bg-gold/10 text-fg"
                    : "border-line-strong bg-surface text-fg-muted hover:text-fg",
                ].join(" ")}
              >
                {chip.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      {/* ── The document ────────────────────────────────────────────── */}
      <StatementDocument pair={pair} statement={statement} />
    </section>
  );
}

function StatementDocument({
  pair,
  statement,
}: {
  pair: StatementPair;
  statement: Statement;
}) {
  return (
    <div className="p-5 print:p-0">
      {/* 🔴 A LAYOUT TABLE, AND ONLY BECAUSE PRINT LEAVES NO OTHER OPTION.
          SPEC §9: "print the period and the coach name in a header that
          SURVIVES A PAGE BREAK." Alex's own July statement is already two
          printed pages, and before this the masthead lived on page 1 only — so
          page 2 carried the payments table, the reconciliation and the current
          balance with NO coach name, NO period and NO direction on it. A sheet
          of money figures about nobody is precisely the §5.0 failure ("a bare
          bold figure with no direction on it") arriving by a different route,
          and on the WORK account it is a payout figure, which §11 calls the
          most expensive mistake available in this feature. Found by rendering
          the PDF and reading page 2; every assertion was green.

          A real <thead> is the ONLY mechanism Chromium actually repeats. Both
          alternatives were TESTED and rejected rather than assumed:
          `display: table-header-group` on a plain <header> does not repeat (and
          it wrecked the detail table's column widths), and Chromium supports
          neither CSS named strings nor running @page margin boxes.

          `role="presentation"` because this asserts no tabular relationship —
          it is a paged-media mechanism, not data. `table-fixed` is load-bearing
          too: with `auto` layout the cell would stretch to the detail table's
          `min-w-[560px]` and put a horizontal scrollbar on the whole page at
          mobile widths instead of letting the inner `overflow-x-auto` scroll. */}
      <table role="presentation" className="w-full table-fixed">
        <thead>
          <tr>
            <td className="p-0 align-top">
              <StatementMasthead pair={pair} statement={statement} />
            </td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="p-0 align-top">
              <StatementBody pair={pair} statement={statement} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Coach + period + DIRECTION, re-stated on EVERY printed page (see the table
 * comment above). Split out only so the repeating region is one component and
 * cannot drift from the body's idea of which account it is describing.
 */
function StatementMasthead({
  pair,
  statement,
}: {
  pair: StatementPair;
  statement: Statement;
}) {
  return (
    <>
      <header className="break-inside-avoid border-b border-line pb-4">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
              PFA · {statementAccountLabel(statement.account)} statement
            </p>
            <h3 className="mt-1 text-xl font-semibold tracking-tight">
              {pair.coachName}
            </h3>
            <p className="text-xs text-fg-subtle">{pair.coachEmail}</p>
          </div>
          {/* Label ABOVE value, not beside it. A side-by-side dt/dd with a
              fixed label column is what let the direction run into the page
              edge in print — and a clipped direction label is exactly the
              40bf31c workbook defect (the half that vanished was "PFA owes
              coaches", leaving a bare figure with no direction on it). */}
          <dl className="grid shrink-0 grid-cols-1 gap-x-8 gap-y-2 text-xs sm:grid-cols-2 sm:text-right">
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                Statement period
              </dt>
              <dd className="mt-0.5 font-medium tabular-nums">
                {pair.periodLabel}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                Direction
              </dt>
              <dd className="mt-0.5 font-semibold">
                {statement.directionLabel}
              </dd>
            </div>
          </dl>
        </div>
      </header>
    </>
  );
}

/**
 * Everything BELOW the repeating masthead.
 *
 * ⚠️ The arithmetic panel lives here and NOT in the header, deliberately: a
 * balance re-printed at the top of page 2 reads as a second, different balance,
 * which is worse than the anonymity this split was made to fix. Only the
 * identity — coach, period, direction — repeats.
 */
function StatementBody({
  pair,
  statement,
}: {
  pair: StatementPair;
  statement: Statement;
}) {
  const chargeTotal = statement.chargesCents;
  const pendingRows = statement.paymentRows.filter((r) => r.pending);
  const settledRows = statement.paymentRows.filter((r) => !r.pending);
  // Cage rows carry a slot count; work rows are `null` because that ledger has
  // no slot model. Derived from the ROWS rather than from `statement.account` so
  // the column follows the data it describes.
  const hasSlots = statement.chargeRows.some((r) => r.slots !== null);

  return (
    <>
      {/* ── The two balance panels, SIDE BY SIDE ──────────────────────────
          They are ONE continuous piece of arithmetic, not two summaries. The
          right panel OPENS on the exact figure the left panel closes with —
          `statement.closingLabel` is rendered in both — and then carries it
          forward to today.

          🔴 The reconciliation used to sit at the BOTTOM, below the charge and
          payment tables. That put the two halves of one calculation a full
          page apart, so the repeated "Statement balance as of Jul 31" line
          read as a duplicate of the total rather than the hand-off it is, and
          checking one against the other meant scrolling past every detail row
          on the page. Adjacent, the shared line is visibly a seam.

          The arithmetic inside each is unchanged, and still in the order Citi
          uses. Boxed for the same reason as before: the figures Mark checks
          first are the ones framed on the page.

          ⚠️ `items-start` so the shorter panel is not stretched to match the
          taller one, and `print:grid-cols-1` because two `max-w-md` panels do
          NOT fit side by side on letter paper — at roughly 350px each the
          longest label ("Payments & credits covering this period") wraps under
          its own figure, and a cramped money row is precisely what this
          document's print pass has had to fix twice already. In print they
          stack, in this same order. */}
      <div className="mt-5 grid gap-6 md:grid-cols-2 md:items-start print:grid-cols-1 print:gap-5">
        <div>
          <PanelHeading>This period</PanelHeading>
          <dl className="max-w-md break-inside-avoid rounded-lg border border-line bg-surface-2/40 p-4 text-sm">
            <Line
              label={statement.openingLabel}
              cents={statement.openingCents}
            />
            <Line
              label="New charges this period"
              cents={chargeTotal}
              sign="+"
            />
            <Line
              label="Payments & credits covering this period"
              cents={statement.paymentsCents}
              sign="−"
            />
            <div className="mt-2 flex items-baseline justify-between gap-4 border-t-2 border-fg/25 pt-2.5">
              <dt className="font-semibold">{statement.closingLabel}</dt>
              <dd className="text-lg font-bold tabular-nums tracking-tight">
                {formatDollarsExact(Math.abs(statement.closingCents))}
                <CreditBadge cents={statement.closingCents} />
              </dd>
            </div>
          </dl>
        </div>

        {/* ── Not included ────────────────────────────────────────────────
            The honesty block. Money we cannot place in a period is not
            evidence about any month, so it is excluded from every figure to
            the left — but silently dropping it would make this document
            disagree with /admin/payments for reasons invisible on the page.
            Itemizing the difference is what makes the statement trustworthy,
            and showing Mark how much money is untagged is what makes him go
            tag it. */}
        {/* 🔴 This panel CONTINUES the left column's arithmetic rather than
            listing three loose figures. The first draft listed "no period
            stated $170" and "charges after $132" and then a bold "$50" —
            which reads as a SUM of the two above it (and $170 + $132 = $302,
            not $50). On a page whose entire claim is "arithmetic you can add
            up yourself", a total that doesn't visibly follow from the lines
            above it is worse than no total at all: it looks like the math is
            broken. So it restates the statement balance, then adds and
            subtracts with explicit signs. */}
        <div>
          <PanelHeading>How this reconciles to today</PanelHeading>
          <dl className="max-w-md break-inside-avoid rounded-lg border border-line bg-surface-2/40 p-4 text-sm">
            <Line
              label={statement.closingLabel}
              cents={statement.closingCents}
            />
            <Line
              label={`Charges after ${pair.periodEndShort}`}
              cents={statement.chargesAfterCents}
              sign="+"
              muted={statement.chargesAfterCents === 0}
            />
            {statement.paymentsCoveringAfterCents > 0 ? (
              <Line
                label={`Payments covering after ${pair.periodEndShort}`}
                cents={statement.paymentsCoveringAfterCents}
                sign="−"
              />
            ) : null}
            <Line
              label="Payments with no period stated"
              cents={statement.unappliedCents}
              sign="−"
              muted={statement.unappliedCents === 0}
            />
            <div className="mt-2 flex items-baseline justify-between gap-4 border-t-2 border-fg/25 pt-2.5">
              <dt className="font-semibold">
                Current account balance
                <span className="ml-1.5 text-xs font-normal text-fg-subtle">
                  (all time, today)
                </span>
              </dt>
              <dd className="font-semibold tabular-nums">
                {formatDollarsExact(Math.abs(statement.currentBalanceCents))}
                <CreditBadge cents={statement.currentBalanceCents} />
              </dd>
            </div>
          </dl>
          <p className="mt-2 max-w-md text-[11px] leading-relaxed text-fg-subtle">
            A statement balance is where this account stood at the end of the
            period. The current balance is where it stands right now. Payments
            with no period stated are counted in no period at all — give one a
            &ldquo;covers through&rdquo; date and it moves onto that
            period&rsquo;s statement.
          </p>
        </div>
      </div>

      {statement.caveat ? (
        <p className="mt-5 flex gap-2.5 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed text-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>{statement.caveat}</span>
        </p>
      ) : null}

      {/* ── Charges ─────────────────────────────────────────────────── */}
      <Block title="Charges this period">
        {statement.scopeNote ? (
          <p className="mb-3 text-[11px] italic text-fg-subtle">
            {statement.scopeNote}
          </p>
        ) : null}

        {statement.chargeLines.length === 0 ? (
          <Empty>No charges in this period.</Empty>
        ) : (
          <>
            <dl className="text-sm">
              {statement.chargeLines.map((line) => (
                <div
                  key={line.label}
                  className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5"
                >
                  <dt>
                    {line.label}
                    <span className="ml-2 text-xs text-fg-subtle">
                      {line.units}
                    </span>
                  </dt>
                  <dd className="tabular-nums">
                    {formatDollarsExact(line.amountCents)}
                  </dd>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-4 pt-2">
                <dt className="font-semibold">Total new charges</dt>
                <dd className="font-semibold tabular-nums">
                  {formatDollarsExact(chargeTotal)}
                </dd>
              </div>
            </dl>

            {/* Itemized, INLINE — not behind a disclosure. A statement that
                gets printed must carry its own detail.

                🔴 THE SLOTS COLUMN IS LOAD-BEARING, NOT DECORATION. Without it
                an off-slot booking printed `9:14 – 10:01 AM · $22.00 /30 min ·
                $66.00` and the only arithmetic a reader could do — 47 minutes
                against the rate — came out roughly HALF the amount charged. The
                slot count is the term that reconciles them, and the explainer
                beneath the table supplies the one fact it needs (a slot is 30
                minutes; bookings bill in whole slots). SPEC §5.3 required "the
                existing Cage Detail column set", which has this column; the
                first build dropped it.

                Rendered only when the account HAS a slot model. Work pay is
                per-hour × exact duration or a flat per-session rate, so a
                column of dashes there would invent a unit that ledger never
                charges in. */}
            <div className="print-flow mt-4 overflow-x-auto rounded-lg border border-line">
              <table className="print-flow w-full min-w-[560px] text-xs">
                <thead className="border-b border-line bg-surface-2/50 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                  <tr>
                    <Th>Date</Th>
                    <Th>Day</Th>
                    <Th>Time</Th>
                    <Th>Description</Th>
                    {hasSlots ? <Th align="right">Slots</Th> : null}
                    <Th align="right">Rate</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {statement.chargeRows.map((row, i) => (
                    <tr
                      key={`${row.date}-${row.description}-${i}`}
                      className="border-b border-line/60 last:border-0"
                    >
                      <Td className="tabular-nums whitespace-nowrap">
                        {row.date}
                      </Td>
                      <Td className="text-fg-muted">{row.dayOfWeek}</Td>
                      <Td className="tabular-nums whitespace-nowrap">
                        {row.timeRange}
                      </Td>
                      <Td>{row.description}</Td>
                      {hasSlots ? (
                        <Td align="right" className="tabular-nums">
                          {row.slots ?? "—"}
                        </Td>
                      ) : null}
                      <Td
                        align="right"
                        className="tabular-nums text-fg-muted whitespace-nowrap"
                      >
                        {row.rateLabel}
                      </Td>
                      <Td align="right" className="tabular-nums font-medium">
                        {formatDollarsExact(row.amountCents)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* The one fact the Slots column needs to be usable. Printed, not a
                tooltip: the reader who most needs it is holding paper. */}
            {hasSlots ? (
              <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
                {CAGE_SLOT_EXPLAINER}
              </p>
            ) : null}
          </>
        )}
      </Block>

      {/* ── Payments ────────────────────────────────────────────────── */}
      <Block title="Payments & credits covering this period">
        {/* 🔴 The empty state is keyed on the WHOLE payment block, not on the
            settled rows alone. Keyed on `settledRows` it contradicted the block
            directly beneath it: a period with only pending payments printed "No
            payments covering this period have been recorded." immediately above
            a Pending block listing them. On a money document a sentence that the
            next paragraph disproves costs more than no sentence at all — it
            makes the reader stop trusting the figures too.

            Three states, each true: rows to show, nothing at all, or nothing
            CONFIRMED but something pending. */}
        {settledRows.length === 0 && pendingRows.length > 0 ? (
          <Empty>
            No confirmed payments covering this period — see pending below,
            which is not counted in the balance.
          </Empty>
        ) : settledRows.length === 0 ? (
          <Empty>
            No payments covering this period have been recorded.
          </Empty>
        ) : (
          <div className="print-flow overflow-x-auto rounded-lg border border-line">
            <table className="print-flow w-full min-w-[520px] text-xs">
              <thead className="border-b border-line bg-surface-2/50 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                <tr>
                  <Th>Paid on</Th>
                  <Th>Method</Th>
                  <Th>Reference</Th>
                  <Th>Covers through</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {settledRows.map((row, i) => (
                  <tr
                    key={`${row.paidOn}-${i}`}
                    className="border-b border-line/60 last:border-0"
                  >
                    <Td className="tabular-nums whitespace-nowrap">
                      {row.paidOn}
                    </Td>
                    <Td>{row.method}</Td>
                    <Td className="text-fg-muted">{row.reference ?? "—"}</Td>
                    <Td className="tabular-nums whitespace-nowrap font-medium">
                      {row.coversThrough ?? (
                        <span className="italic text-fg-subtle">
                          not stated
                        </span>
                      )}
                    </Td>
                    <Td align="right" className="tabular-nums font-medium">
                      {formatDollarsExact(row.amountCents)}
                    </Td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-line">
                <tr>
                  <td colSpan={4} className="px-3 py-2 font-semibold">
                    Total payments &amp; credits
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {formatDollarsExact(statement.paymentsCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Pending is SHOWN but never counted — netCoachLedgers already
            refuses to let it move a balance, and the statement must not
            disagree with it. Dropping it silently would be a support call. */}
        {pendingRows.length > 0 ? (
          <div className="mt-3 break-inside-avoid rounded-lg border border-dashed border-line-strong p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              Pending — not included in the balance above
            </p>
            {/* A pending payment with NO coverage date is listed here too (see
                the engine's untagged-pending branch): it belongs to no period,
                so it appears on every period's statement rather than one, and
                the note says why it is here at all. Before this it appeared
                NOWHERE, though /admin/payments showed it. */}
            {pendingRows.some((r) => r.coversThrough === null) ? (
              <p className="mt-1 text-[11px] text-fg-subtle">
                One or more of these states no period. It is shown so it is not
                lost, and it is counted in no period&rsquo;s figures — give it a
                &ldquo;covers through&rdquo; date and confirm it to place it.
              </p>
            ) : null}
            <ul className="mt-2 space-y-1 text-xs">
              {pendingRows.map((row, i) => (
                <li
                  key={`${row.paidOn}-pending-${i}`}
                  className="flex items-baseline justify-between gap-4"
                >
                  <span>
                    <span className="tabular-nums">{row.paidOn}</span> ·{" "}
                    {row.method}
                    {row.reference ? (
                      <span className="text-fg-muted"> · {row.reference}</span>
                    ) : null}
                    {row.coversThrough ? (
                      <span className="text-fg-muted">
                        {" "}
                        · covers through {row.coversThrough}
                      </span>
                    ) : (
                      // Said out loud rather than left blank: a row with no
                      // coverage date beside rows that have one reads as a
                      // rendering gap unless the absence is stated.
                      <span className="italic text-fg-subtle">
                        {" "}
                        · no period stated
                      </span>
                    )}
                  </span>
                  <span className="tabular-nums">
                    {formatDollarsExact(row.amountCents)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-fg-subtle">
              A pending payment moves no balance until it is confirmed.
            </p>
          </div>
        ) : null}
      </Block>
    </>
  );
}

/* ── small pieces ─────────────────────────────────────────────────────── */

/**
 * SPEC §5.2 — "`$40.00 credit` with the direction stated", and it is BOTH, not
 * either. The engine keeps cents signed and flips `directionLabel` when a
 * balance goes negative, so the sentence is already correct; every place this
 * file renders `Math.abs` therefore has to say WHY the sign was dropped, or an
 * overpaid account renders byte-identical to a normally-owed one and the only
 * difference is a sentence in a different element.
 *
 * 🔴 ONE badge, three call sites (the two header balance cells, the arithmetic
 * block's closing line, and the reconciliation block's current balance). Two of
 * those shipped bare in the mock while the third carried an inline badge — one
 * document disagreeing with itself about the same rule. A component rather than
 * a repeated span so a future fourth money cell inherits the idiom instead of
 * inventing a second one.
 *
 * Renders nothing at zero: square is not a credit.
 */
function CreditBadge({ cents }: { cents: number }) {
  if (cents >= 0) return null;
  return (
    <span className="ml-1.5 text-xs font-semibold uppercase tracking-wider text-fg-muted">
      credit
    </span>
  );
}

/**
 * One row of a printed arithmetic column.
 *
 * 🔴 THE PRESENCE OF `sign` IS WHAT DISTINGUISHES THE TWO KINDS OF FIGURE HERE,
 * and the distinction decides where a credit marker belongs:
 *
 *   · **No `sign` → a signed BALANCE.** Exactly two rows in this document:
 *     "Previous balance (as of …)" and the reconciliation panel's restated
 *     closing balance. Both can legitimately be negative — a coach who prepaid
 *     in June opens July at −$40 — so both get the marker. This is the guard,
 *     and it is live: without it, the previous-balance line printed "$40.00" for
 *     $40 of CREDIT, asserting the wrong direction on the statement's first
 *     line, and every figure below it derives from that line.
 *
 *   · **With `sign` → a MAGNITUDE beside an explicit operator** (new charges,
 *     payments covering, charges after, payments with no period stated). Each is
 *     a sum of non-negative amounts — `amountCents` is `.positive()` in the
 *     payment schema, and a charge is slots × a non-negative snapshot rate — so
 *     none of them can go negative. A badge on these rows would be dead code
 *     today and AMBIGUOUS if it ever fired: "− $40.00 credit" is a double
 *     negative that reads as +$40 to a careful reader and −$40 to everyone else.
 *     So they get no badge.
 *
 * The magnitude rows are not left unguarded, though: their OPERATOR FOLLOWS THE
 * SIGN. If a negative ever reaches one, the row prints "− $40.00" instead of
 * "+ $40.00" and the column still foots, rather than silently being wrong by
 * twice the amount. That keeps SPEC §2 rule 1 — the arithmetic is visible and it
 * ties out — true by construction instead of by assumption about upstream data.
 */
function Line({
  label,
  cents,
  sign,
  muted = false,
}: {
  label: string;
  cents: number;
  sign?: "+" | "−";
  muted?: boolean;
}) {
  // Unreachable with today's inputs (see above) and deliberately not an
  // exception: a statement that throws is a statement Mark cannot read at all,
  // and the honest fallback for a money column is one that still adds up.
  const operator = sign === undefined ? undefined : cents < 0 ? flipSign(sign) : sign;

  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/60 py-1.5">
      <dt className={muted ? "text-fg-muted" : undefined}>{label}</dt>
      <dd
        className={[
          "tabular-nums",
          muted ? "text-fg-muted" : undefined,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {operator ? (
          <span className="mr-1.5 text-fg-muted">{operator}</span>
        ) : null}
        {formatDollarsExact(Math.abs(cents))}
        {/* Balance rows only — an operator row carries its sign in the
            operator, so a badge there would be the double negative. */}
        {sign === undefined ? <CreditBadge cents={cents} /> : null}
      </dd>
    </div>
  );
}

function flipSign(sign: "+" | "−"): "+" | "−" {
  return sign === "+" ? "−" : "+";
}

/**
 * The heading over each of the two top balance panels.
 *
 * Deliberately the SAME type treatment as `Block`'s `<h4>` rather than a second
 * heading idiom — the panels sit above the blocks on the same document, and two
 * section-heading styles on one page is how a reader stops being able to tell
 * what is a peer of what. It is a separate component only because `Block`
 * carries `mt-7` and renders a `<section>`, both wrong inside a grid cell where
 * the two headings must sit on the same line for the panels to align.
 */
function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-3 break-after-avoid text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
      {children}
    </h4>
  );
}

function Block({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    // NOT break-inside-avoid: the charge detail is long, and forbidding a
    // break inside it shoved the whole section to page 2 and left the first
    // page half empty. Only the HEADING is kept with what follows it.
    <section className="mt-7">
      <h4 className="mb-3 break-after-avoid text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
        {title}
      </h4>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs italic text-fg-subtle">{children}</p>;
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      {children}
    </td>
  );
}

// The one interactive leaf in an otherwise fully server-rendered document.
function PrintButton() {
  return (
    <ClientPrintButton>
      <Printer className="h-3.5 w-3.5" />
      Print statement
    </ClientPrintButton>
  );
}
