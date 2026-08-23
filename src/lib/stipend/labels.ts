// stipend SPEC §10.3/§10.4 — the WORDS every stipend surface uses.
//
// 🔴 ONE definition, imported by the statement engine, the Work tab's rate
// cell and the Excel workbook. These three have already drifted once in this
// repo: `MAINTENANCE-HANDOFF` records the payout caveat living in three places
// with `engine.ts` requiring it be VERBATIM with `work-preview.tsx`, enforced
// only by a comment. A shared constant is the version of that rule the
// compiler keeps.
//
// Why the wording matters more than it looks:
//   · "No rate" beside 72 real hours reads as a MISCONFIGURATION. Mark's whole
//     Q2 ask is to see the hours AND see they are deliberately not charged.
//   · "$0.00/hr" reads as a decision to pay nothing per hour, which is a
//     different — and wrong — claim. `workRateLabel` already refuses to render
//     a zero for exactly this reason.
//   · "Flat rate" on the stipend row itself says the amount is not derived
//     from hours at all, so a reader stops looking for the multiplication.

/** The rate cell on a LOG whose pay is $0 because a stipend covers it. */
export const COVERED_BY_STIPEND_LABEL = "Covered by stipend";

/** The rate cell on the STIPEND row itself. Never "$0.00/hr". */
export const STIPEND_FLAT_RATE_LABEL = "Flat rate";

/**
 * The statement's CHARGES-THIS-PERIOD bucket for a stipend. Its own line,
 * never merged into a program's — the rates are not comparable and a merged
 * line would invite a reader to divide the total by the hours and get a
 * per-hour figure nobody ever charged.
 */
export const STIPEND_LINE_LABEL = "Stipend";

/**
 * 🔴 THE WORK-PAY CAVEAT, IN TWO SENTENCES THAT ARE STORED SEPARATELY.
 *
 * One definition, three surfaces: the printed statement (`statement/engine.ts`),
 * the Work tab (`work-preview.tsx`) and the Excel workbook (`excel.ts`).
 *
 * ── Why it changed ──────────────────────────────────────────────────────
 * It used to read *"This is what the logged work is worth — not what is still
 * owed."* That became FALSE the moment a stipend line could appear beside it:
 * **a stipend is not logged work.** `engine.ts` already required this string be
 * VERBATIM with `work-preview.tsx`, enforced only by a comment; this constant
 * is the version of that rule the compiler keeps.
 *
 * ── 🔴 WHY IT IS SPLIT, AND WHY THAT IS NOT COSMETIC ────────────────────
 * The workbook writes each note as a row in COLUMN A, which can only overflow
 * across the empty cells beside it — about **90 characters** before Excel
 * clips it. The joined sentence is **134**. Shipping it as one string put a
 * caveat on the deliverable Mark emails around that would be **cut off
 * mid-sentence**, on the exact surface whose own comment says *"a caveat that
 * gets cut off mid-sentence is worse than one that reads."*
 *
 * So: HTML surfaces join the two (`WORK_PAY_CAVEAT`); the workbook writes them
 * as two rows. ⚠️ Keep each half under ~90 characters.
 */
export const WORK_PAY_CAVEAT_LEAD =
  "This is what the logged work and any stipends are worth — not what is still owed.";

export const WORK_PAY_CAVEAT_PAYMENTS =
  "Payments made outside the app are not deducted here.";

/** The two sentences joined, for surfaces that wrap freely (HTML, print). */
export const WORK_PAY_CAVEAT = `${WORK_PAY_CAVEAT_LEAD} ${WORK_PAY_CAVEAT_PAYMENTS}`;

/**
 * The scope line beneath the caveat. Gained its stipend clause at the same
 * time: without it the document silently describes a scope it no longer has.
 */
export const WORK_SCOPE_NOTE_TEXT =
  "Posted work only — rejected and held logs are excluded. A stipend is " +
  "earned for a whole pay period, never pro-rated.";
