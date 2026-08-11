// Builds the downloadable workbook from aggregated report data.
//
// FIVE sheets (reports-tabs SPEC §5 + §11 decision 2):
//   Cage Summary · Cage Detail · Work Summary · Work Detail · Payments
//
// The workbook is UNCONDITIONALLY COMPLETE. It spans every category no
// matter which sub-tab was open when the button was clicked, and the
// download route deliberately carries no `tab` param. A file that is
// silently narrowed by screen state is the §1(a) defect this feature
// exists to close — work sessions had never appeared in a Reports export
// at all.
//
// ⚠️ The work sheets are NOT built from `buildHourLogWorkbook`. That
// builder is HOURS-ONLY — the admin Work Log stack carries no money
// whatsoever (SPEC §12, Phase C finding 1). They are fed from
// `buildWorkReport`, the same function the Work tab renders, so the file
// and the screen cannot quote different pay.
//
// Money direction is preserved end to end (SPEC §7): cage rentals are
// money coaches owe PFA, work hours are money PFA owes coaches, payments
// run both ways. No sheet sums across those directions and there is no
// combined "total" anywhere in this file.
//
// Cents discipline:
//   - All money values arrive in cents from aggregateReport /
//     buildWorkReport / buildPaymentTimeline.
//   - We divide by 100 to write a JS number to the cell and apply
//     a currency numFmt so Excel renders "$X.XX".
//   - At the magnitudes we deal with (<= ~$10k per session), JS float
//     precision is safe. The integer-cents discipline upstream means
//     no .01-precision loss in totals.

import ExcelJS from "exceljs";
import type { ReportData } from "./aggregate";
import {
  paymentDirectionLabel,
  type PaymentEventKind,
  type PaymentTimelineData,
} from "./payments-timeline";
import { cageRateParts } from "./rate-display";
import { formatPfaDate, formatPfaTime12h } from "@/lib/timezone";
import type { WorkReportData } from "./work-report";

export type WorkbookMeta = {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
};

/**
 * Everything the workbook renders. One object rather than a growing
 * positional list so a future sheet can't be wired to the wrong argument.
 */
export type ReportWorkbookInput = {
  /** Cage-side aggregate — coaches owe PFA. */
  report: ReportData;
  /** Work-side rollup — PFA owes coaches. From `buildWorkReport`. */
  work: WorkReportData;
  /** The payment audit timeline for the same range. */
  payments: PaymentTimelineData;
  /**
   * True when the timeline hit its fetch cap. SAID ON THE SHEET — a
   * silently shortened money history inside a file someone emails on is
   * worse than on screen, because the caveat can't be re-read from the UI.
   */
  paymentsTruncated: boolean;
};

const CURRENCY_FMT = '"$"#,##0.00';

export async function buildReportWorkbook(
  input: ReportWorkbookInput,
  meta: WorkbookMeta,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PFA Engine";
  workbook.created = new Date();
  workbook.subject = `Billing ${meta.from} to ${meta.to}`;

  addSummarySheet(workbook, input.report);
  addDetailSheet(workbook, input.report);
  addWorkSummarySheet(workbook, input.work);
  addWorkDetailSheet(workbook, input.work);
  addPaymentsSheet(workbook, input.payments, input.paymentsTruncated);

  // exceljs writeBuffer returns ArrayBuffer / Uint8Array; coerce to
  // Node Buffer so Next.js's Response constructor doesn't get cute
  // with the encoding.
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

function addSummarySheet(workbook: ExcelJS.Workbook, report: ReportData) {
  // Named for the Cage Detail sheet it pairs with. It also carries the
  // per-coach work rollup ("Work Hours" / "Work $") — that pairing is the
  // one place a reader can see both money directions for a coach on one
  // line, it predates this feature, and dropping it would be an unasked-for
  // regression. The two figures are never added together, and the Work
  // Summary sheet's grand total reproduces the "Work $" column exactly
  // (both come from `workPayForLog` over the same posted rows).
  const sheet = workbook.addWorksheet("Cage Summary");

  // Every category, always. The scope checkboxes that used to drop
  // columns from this sheet are gone (reports-tabs SPEC): a download must
  // never be silently narrowed by what happens to be on screen, so the
  // workbook is unconditionally complete. `dollar` columns get currency
  // format, `num` columns get right-alignment — tracked by key.
  type SummaryCol = {
    header: string;
    key: string;
    width: number;
    kind?: "dollar" | "num";
  };
  const columns: SummaryCol[] = [
    { header: "Coach", key: "coach", width: 28 },
    { header: "Email", key: "email", width: 28 },
    // Cage rental sessions — money the coach owes PFA.
    { header: "Cage Slots", key: "cageSlots", width: 12, kind: "num" },
    { header: "Cage $", key: "cageDollars", width: 12, kind: "dollar" },
    { header: "Bullpen Slots", key: "bullpenSlots", width: 13, kind: "num" },
    { header: "Bullpen $", key: "bullpenDollars", width: 12, kind: "dollar" },
    {
      header: "WeightRoom Slots",
      key: "weightRoomSlots",
      width: 18,
      kind: "num",
    },
    {
      header: "WeightRoom $",
      key: "weightRoomDollars",
      width: 14,
      kind: "dollar",
    },
    {
      header: "Group WeightRoom Slots",
      key: "groupWeightRoomSlots",
      width: 22,
      kind: "num",
    },
    {
      header: "Group WeightRoom $",
      key: "groupWeightRoomDollars",
      width: 20,
      kind: "dollar",
    },
    // Work hours (coach pay, a payout) — the amount PFA owes the coach.
    // NEVER summed with the cage receivable.
    { header: "Work Hours", key: "programHours", width: 13, kind: "num" },
    { header: "Work $", key: "programDollars", width: 12, kind: "dollar" },
    // Cage-side receivable subtotal (cage + bullpen + weight room).
    // Never merged with work pay.
    { header: "Rental Owed $", key: "cageOwed", width: 13, kind: "dollar" },
  ];

  sheet.columns = columns.map(({ header, key, width }) => ({
    header,
    key,
    width,
  }));

  for (const row of report.summary) {
    sheet.addRow({
      coach: row.coachName,
      email: row.coachEmail,
      cageSlots: row.cageSlots,
      cageDollars: row.cageTotalCents / 100,
      bullpenSlots: row.bullpenSlots,
      bullpenDollars: row.bullpenTotalCents / 100,
      weightRoomSlots: row.weightRoomSlots,
      weightRoomDollars: row.weightRoomTotalCents / 100,
      groupWeightRoomSlots: row.groupWeightRoomSlots,
      groupWeightRoomDollars: row.groupWeightRoomTotalCents / 100,
      programHours: row.programHours,
      programDollars: row.programTotalCents / 100,
      cageOwed: row.totalCents / 100, // cage-side receivable subtotal
    } satisfies Record<string, string | number>);
  }

  // Grand total row at the bottom. Two SEPARATE grand totals, each under its
  // own column and never summed: the cage receivable under "Rental Owed $",
  // the work payout under "Work $". Opposite money directions.
  if (report.summary.length > 0) {
    const totalRow = sheet.addRow({
      coach: `Grand total (${report.detail.length} sessions)`,
      cageOwed: report.grandTotalCents / 100,
      programDollars: report.programGrandTotalCents / 100,
    } satisfies Record<string, string | number>);
    totalRow.font = { bold: true };
    totalRow.getCell("coach").alignment = { horizontal: "right" };
  }

  // Style the header row.
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };
  headerRow.border = { bottom: { style: "thin" } };

  // Currency formatting on the $ columns, right-align on slot counts.
  for (const c of columns) {
    if (c.kind === "dollar") {
      const col = sheet.getColumn(c.key);
      col.numFmt = CURRENCY_FMT;
      col.alignment = { horizontal: "right" };
    } else if (c.kind === "num") {
      sheet.getColumn(c.key).alignment = { horizontal: "right" };
    }
  }

  // Freeze the header row so it stays put while Dad scrolls. Meta
  // (the date range) lives on the workbook itself via `subject`.
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function addDetailSheet(workbook: ExcelJS.Workbook, report: ReportData) {
  const sheet = workbook.addWorksheet("Cage Detail");

  sheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Day", key: "day", width: 6 },
    { header: "Start", key: "start", width: 8 },
    { header: "End", key: "end", width: 8 },
    { header: "Duration (min)", key: "duration", width: 14 },
    { header: "Resource", key: "resource", width: 14 },
    { header: "Coach", key: "coach", width: 24 },
    { header: "Slots", key: "slots", width: 8 },
    { header: "Rate", key: "rate", width: 10 },
    { header: "Rate basis", key: "rateBasis", width: 12 },
    { header: "$", key: "total", width: 12 },
    { header: "Note", key: "note", width: 40 },
  ];

  for (const row of report.detail) {
    // The stored snapshot is per-30-min cents. Weight-room rates display
    // per HOUR (×2); cage/bullpen stay per 30 min. The adjacent "Rate basis"
    // column makes the numeric Rate cell's unit unambiguous per row. This is
    // display-only — totals and the stored snapshot are untouched.
    //
    // ⚠️ The rule itself is `cageRateParts` (lib/reports/rate-display.ts), shared
    // with the Reports screen's `RateCell` and the payment statement's charge
    // rows. It was written out separately in each of the three, and the
    // statement's copy DISAGREED (it quoted everything per hour), so one
    // session's rate read three ways across screen, workbook and printed
    // statement. Values in this sheet are unchanged — this call is the same
    // arithmetic, from one place.
    const { amountCents: rateDisplayCents, unit } = cageRateParts(
      row.ratePerSlotCents,
      row.resourceType,
    );
    const perHour = unit === "/hr";
    // Group weight-room sessions share the weight_room rate basis (per hr)
    // but must be visually distinguishable in the detail sheet — tag the
    // resource label so a scan of the Resource column separates them from
    // regular weight-room rentals.
    const resourceLabel =
      row.resourceType === "weight_room" && row.isGroupSession
        ? `${row.resourceName} (Group)`
        : row.resourceName;
    sheet.addRow({
      date: row.date,
      day: row.dayOfWeek,
      start: row.startTime,
      end: row.endTime,
      duration: row.durationMinutes,
      resource: resourceLabel,
      coach: row.coachName,
      slots: row.slots,
      rate: rateDisplayCents / 100,
      rateBasis: perHour ? "per hr" : "per 30 min",
      total: row.totalCents / 100,
      note: row.note ?? "",
    });
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.border = { bottom: { style: "thin" } };

  for (const key of ["rate", "total"] as const) {
    const col = sheet.getColumn(key);
    col.numFmt = CURRENCY_FMT;
    col.alignment = { horizontal: "right" };
  }
  for (const key of ["slots", "duration"] as const) {
    sheet.getColumn(key).alignment = { horizontal: "right" };
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

// ── Work sheets ──────────────────────────────────────────────────────────
// PFA OWES THE COACH. Both are fed from `buildWorkReport`, whose summary is
// a roll-up of the very rows on the detail sheet — so the two sheets cannot
// disagree with each other or with the Work tab on screen.

function addWorkSummarySheet(
  workbook: ExcelJS.Workbook,
  work: WorkReportData,
) {
  const sheet = workbook.addWorksheet("Work Summary");

  sheet.columns = [
    { header: "Coach", key: "coach", width: 28 },
    { header: "Email", key: "email", width: 28 },
    { header: "Entries", key: "entries", width: 10 },
    { header: "Hours", key: "hours", width: 10 },
    { header: "Work Pay $", key: "pay", width: 14 },
  ];

  for (const row of work.summary) {
    sheet.addRow({
      coach: row.coachName,
      email: row.coachEmail,
      entries: row.entries,
      hours: roundHours(row.hours),
      pay: row.payCents / 100,
    });
  }

  // The grand total says WHICH WAY THE MONEY GOES, in the label. A bare
  // bold number at the bottom of a payroll sheet is exactly the figure
  // SPEC §7 warns gets read as "what coaches owe".
  if (work.summary.length > 0) {
    // The direction goes in its OWN cell rather than into the label. A
    // right-aligned label longer than its column clips on the left in
    // Excel, and "PFA owes coaches" is the half that would have been cut —
    // leaving a bare bold payroll number with no direction on it, which is
    // precisely the misreading §7 exists to prevent.
    const totalRow = sheet.addRow({
      coach: `Grand total (${work.detail.length} entries)`,
      email: "PFA owes coaches",
      hours: roundHours(work.grandTotalHours),
      pay: work.grandTotalCents / 100,
    });
    totalRow.font = { bold: true };
    totalRow.getCell("coach").alignment = { horizontal: "right" };
  }

  // 🔴 SPEC §7, the same sentence the Work tab carries on screen. The app
  // has no payout ledger — Mark pays coaches outside the system — so this
  // total is what the logged work is WORTH, not what is still outstanding.
  // The workbook gets emailed around and outlives the page, so the caveat
  // has to travel with it.
  //
  // Kept to SHORT lines on purpose. A note row lives in column A and can
  // only overflow across the empty cells beside it (~90 characters here);
  // past that Excel clips it. A caveat that gets cut off mid-sentence is
  // worse than one that reads.
  addNoteRows(sheet, [
    "This is what the logged work is worth — not what is still owed.",
    "Payments made outside the app are not deducted here.",
    "Posted work only. Rejected entries are on the Work Log page.",
  ]);

  styleHeader(sheet);
  sheet.getColumn("pay").numFmt = CURRENCY_FMT;
  for (const key of ["entries", "hours", "pay"] as const) {
    sheet.getColumn(key).alignment = { horizontal: "right" };
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function addWorkDetailSheet(workbook: ExcelJS.Workbook, work: WorkReportData) {
  const sheet = workbook.addWorksheet("Work Detail");

  sheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Day", key: "day", width: 6 },
    { header: "Start", key: "start", width: 8 },
    { header: "End", key: "end", width: 8 },
    { header: "Hours", key: "hours", width: 8 },
    { header: "Program", key: "program", width: 28 },
    { header: "Coach", key: "coach", width: 24 },
    { header: "Rate", key: "rate", width: 12 },
    { header: "Rate basis", key: "rateBasis", width: 13 },
    { header: "Pay $", key: "pay", width: 12 },
    { header: "Note", key: "note", width: 30 },
    { header: "Schedule", key: "scheduleNote", width: 30 },
  ];

  for (const row of work.detail) {
    const rate = workRateCell(row.ratePer30MinCents, row.perSessionRateCents);
    sheet.addRow({
      date: row.date,
      day: row.dayOfWeek,
      start: row.startTime,
      end: row.endTime,
      hours: roundHours(row.hours),
      program: row.programName,
      coach: row.coachName,
      // Deliberately left EMPTY when no rate was ever stamped. Writing 0
      // there renders "$0.00", which reads as a deliberate zero rate rather
      // than a missing one — the exact distinction the on-screen "No rate"
      // cell exists to make.
      rate: rate.dollars,
      rateBasis: rate.basis,
      pay: row.payCents / 100,
      note: row.note ?? "",
      scheduleNote: row.scheduleNote ?? "",
    });
  }

  styleHeader(sheet);
  for (const key of ["rate", "pay"] as const) {
    const col = sheet.getColumn(key);
    col.numFmt = CURRENCY_FMT;
    col.alignment = { horizontal: "right" };
  }
  sheet.getColumn("hours").alignment = { horizontal: "right" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * Mirrors the Work tab's `RateCell` exactly, so a row reads the same in the
 * file as it does on screen:
 *   per-session log → the flat amount, basis "per session"
 *   hourly log      → the per-30-min snapshot ×2, basis "per hr"
 *   no rate stamped → no amount at all, basis "No rate"
 */
export function workRateCell(
  ratePer30MinCents: number | null,
  perSessionRateCents: number | null,
): { dollars: number | undefined; basis: string } {
  if (perSessionRateCents != null) {
    return { dollars: perSessionRateCents / 100, basis: "per session" };
  }
  if (ratePer30MinCents == null) {
    return { dollars: undefined, basis: "No rate" };
  }
  // Stored per 30 min; work pay is quoted per HOUR, so ×2 for display.
  return { dollars: (ratePer30MinCents * 2) / 100, basis: "per hr" };
}

// ── Payments sheet ───────────────────────────────────────────────────────

const KIND_LABEL: Record<PaymentEventKind, string> = {
  recorded: "Recorded",
  edited: "Edited",
  confirmed: "Confirmed",
  deleted: "Deleted",
};

function addPaymentsSheet(
  workbook: ExcelJS.Workbook,
  payments: PaymentTimelineData,
  truncated: boolean,
) {
  const sheet = workbook.addWorksheet("Payments");

  sheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Time", key: "time", width: 10 },
    { header: "Event", key: "event", width: 11 },
    // Which payment this event belongs to. Two things need it, and neither
    // is visible until you read a real export:
    //   1. Two DIFFERENT payments of the same amount to the same coach on
    //      the same day render as identical rows. "Was this recorded
    //      twice by mistake?" is a question a reader of a money log will
    //      actually ask, and without this they cannot answer it.
    //   2. The timeline interleaves several events per payment. On screen
    //      that grouping is implicit in the ordering; in a flat sheet it is
    //      lost entirely unless there is something to sort or filter on.
    { header: "Payment", key: "payment", width: 12 },
    { header: "Coach", key: "coach", width: 24 },
    { header: "Amount $", key: "amount", width: 13 },
    { header: "Direction", key: "direction", width: 17 },
    { header: "By", key: "actor", width: 24 },
    { header: "What changed", key: "changes", width: 46 },
    { header: "Payment status", key: "status", width: 15 },
  ];

  for (const e of payments.events) {
    sheet.addRow({
      date: formatPfaDate(e.ts),
      time: formatPfaTime12h(e.ts),
      event: KIND_LABEL[e.kind],
      // Short form — enough to tell two payments apart or group a
      // payment's events together, without a 36-character uuid dominating
      // the sheet. Prefixed so nothing tries to read it as a number.
      payment: shortPaymentRef(e.paymentId),
      coach: e.coachLabel,
      // Never invent a figure: an event whose changed-keys-only diff
      // carries no amount and whose payment row no longer joins renders
      // BLANK, not $0.00 (SPEC §12, Phase D finding 2).
      amount: e.amountCents === null ? undefined : e.amountCents / 100,
      direction: e.direction === null ? "" : paymentDirectionLabel(e.direction),
      actor: e.actorLabel,
      changes: e.changes
        .map((c) => `${c.label}: ${c.from ?? "—"} → ${c.to ?? "—"}`)
        .join("; "),
      status: e.paymentDeleted ? "Deleted" : "",
    });
  }

  if (payments.events.length === 0) {
    addNoteRows(sheet, ["No payment activity in this date range."]);
  }

  // Truncation is stated BEFORE the totals, because it invalidates them.
  if (truncated) {
    addNoteRows(sheet, [
      "⚠️ TRUNCATED — this range has more payment activity than fits in one export.",
      "The rows and totals below are the most recent entries ONLY.",
      "Narrow the dates or pick a coach to see the rest.",
    ]);
  }

  // Two totals, side by side, NEVER netted (SPEC §7) — and built from
  // "recorded" events only, so a payment recorded+edited+confirmed in the
  // same window counts once and a reader can reproduce the figure by
  // adding up the rows above it.
  // Label in the first column, figure in the money column — the same
  // layout the Cage and Work summary sheets use for their grand totals, so
  // a reader's eye lands the same way on every sheet in the file.
  sheet.addRow({});
  const coachToPfa = sheet.addRow({
    date: "Recorded in range — coach paid PFA",
    amount: payments.totals.recordedCoachToPfaCents / 100,
  });
  const pfaToCoach = sheet.addRow({
    date: "Recorded in range — PFA paid coach",
    amount: payments.totals.recordedPfaToCoachCents / 100,
  });
  for (const row of [coachToPfa, pfaToCoach]) {
    row.font = { bold: true };
    row.getCell("date").alignment = { horizontal: "left" };
  }

  // SPEC §11 decision 4. These are RANGED and will legitimately not match
  // the Payments page's all-time balances; an unlabelled difference between
  // two money surfaces reads as a bug in the money.
  const notes = [
    `Payments recorded in range: ${payments.totals.recordedCount}.`,
    "Totals cover payments RECORDED in this date range. They are activity,",
    "not balances, and will not match the Payments page's all-time figures.",
    // A payment has no resource and no program, so those filters have
    // nothing to narrow here. Without this line, an admin who exported
    // with a program filter set would reasonably read this sheet as
    // program-scoped and conclude the other payments are missing.
    "Scope: the date range and the coach filter only. The resource-type and",
    "program filters do not apply to payments.",
  ];
  if (payments.totals.recordedSinceDeletedCount > 0) {
    notes.push(
      `${payments.totals.recordedSinceDeletedCount} of those payments ${
        payments.totals.recordedSinceDeletedCount === 1 ? "has" : "have"
      } since been deleted and ${
        payments.totals.recordedSinceDeletedCount === 1 ? "is" : "are"
      } still counted above.`,
    );
  }
  addNoteRows(sheet, notes);

  styleHeader(sheet);
  const amount = sheet.getColumn("amount");
  amount.numFmt = CURRENCY_FMT;
  amount.alignment = { horizontal: "right" };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

// ── Shared sheet helpers ─────────────────────────────────────────────────

function styleHeader(sheet: ExcelJS.Worksheet) {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };
  headerRow.border = { bottom: { style: "thin" } };
}

/**
 * The first segment of a payment's uuid, prefixed. Long enough to separate
 * any two payments a human is comparing on one sheet, short enough not to
 * crowd out the money. `#` keeps Excel from guessing at a numeric type on
 * an all-digit segment.
 */
export function shortPaymentRef(paymentId: string): string {
  return `#${paymentId.slice(0, 8)}`;
}

/**
 * Caveat / footnote lines under a table, one per row in the first column.
 * Written as plain rows rather than merged cells so a reader who sorts or
 * filters the sheet does not silently destroy the note.
 */
function addNoteRows(sheet: ExcelJS.Worksheet, lines: string[]) {
  sheet.addRow({});
  for (const line of lines) {
    const row = sheet.addRow([line]);
    row.getCell(1).font = { italic: true, size: 10 };
  }
}

/**
 * Hours carry real fractions (a 45-min log is 0.75). Round for the cell so
 * float noise can't surface as 2.9999999999999996 in a file Dad reads —
 * 2dp is finer than any loggable duration. Pay is NOT rounded here: it is
 * integer cents upstream.
 */
function roundHours(hours: number): number {
  return Math.round(hours * 100) / 100;
}
