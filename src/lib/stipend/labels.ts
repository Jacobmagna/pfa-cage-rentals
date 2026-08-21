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
 * 🔴 THE WORK-PAY CAVEAT. One definition, three surfaces: the printed
 * statement (`statement/engine.ts`), the Work tab (`work-preview.tsx`) and the
 * Excel workbook (`excel.ts`).
 *
 * ── Why it changed, and why all three moved together ────────────────────
 * It used to read *"This is what the logged work is worth — not what is still
 * owed."* That sentence became FALSE the moment a stipend line appeared beside
 * it: **a stipend is not logged work.** It is owed to a person for a period,
 * and no amount of reading the hours explains where the figure came from.
 *
 * `engine.ts`'s own comment already required this string be VERBATIM with
 * `work-preview.tsx`, enforced only by a comment, and `MAINTENANCE-HANDOFF`
 * records that the same stale framing had drifted into a third place. This
 * constant is the version of that rule the compiler keeps.
 *
 * ⚠️ Overstating what a coach is owed IN WRITING is the most expensive mistake
 * available in this feature — this is the document Mark hands to a coach. The
 * wording therefore still says plainly that outside payments are not deducted.
 */
export const WORK_PAY_CAVEAT =
  "This is what the logged work and any stipends are worth — not what is " +
  "still owed. Payments made outside the app are not deducted here.";

/**
 * The scope line beneath the caveat. Gained its stipend clause at the same
 * time: without it the document silently describes a scope it no longer has.
 */
export const WORK_SCOPE_NOTE_TEXT =
  "Posted work only — rejected and held logs are excluded. A stipend is " +
  "earned for a whole pay period, never pro-rated.";
