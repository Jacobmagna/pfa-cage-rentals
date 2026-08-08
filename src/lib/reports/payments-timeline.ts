// The Reports "Payments" tab (reports-tabs SPEC §3, tab 3).
//
// This is an APPEND-ONLY TIMELINE OF ACTIONS, not a balance sheet. Each
// row records something that happened to a payment — recorded, edited,
// confirmed, deleted — sourced from `audit_log` where
// `entityType = 'payment'`. A timeline row is history: it is never
// editable. What is editable is the underlying PAYMENT, and an edit
// APPENDS a new event rather than rewriting the old one (SPEC §3).
//
// ── Reading the audit payload correctly ──────────────────────────────────
// Two things about how payments are audited shape everything here, and
// both are easy to get wrong from the outside:
//
//  1. CONFIRM IS LOGGED AS AN `update`, not its own action
//     (`confirmPaymentInternal` in payment-actions.ts). So "edited" and
//     "confirmed" cannot be told apart by `action` alone — they are
//     separated by looking at whether the diff moved `status` to
//     "confirmed". See `deriveEventKind`.
//
//  2. AN `update` DIFF IS CHANGED-KEYS-ONLY (`shallowDiff` in lib/audit.ts).
//     An edit that did not touch the amount carries NO amount, and a
//     confirm carries only status/confirmedBy/confirmedAt. So an event's
//     own payload cannot be relied on for the coach or the amount; those
//     come from the joined payment row, which is why the fetch joins it.
//
// ── Money direction ──────────────────────────────────────────────────────
// Payments run BOTH ways (coach→PFA for rentals, PFA→coach for work pay).
// The two are reported side by side and NEVER netted into one number
// (SPEC §7).

import type { PaymentDirection } from "@/db/schema";
import { formatPfaDate } from "@/lib/timezone";

/** What happened to the payment. */
export type PaymentEventKind =
  | "recorded"
  | "edited"
  | "confirmed"
  | "deleted";

/** One human-readable field change, for the "what changed" column. */
export type PaymentFieldChange = {
  label: string;
  from: string | null;
  to: string | null;
};

export type PaymentTimelineEvent = {
  /** The audit row id — a stable React key. NOT the payment id. */
  id: string;
  paymentId: string;
  ts: Date;
  kind: PaymentEventKind;
  actorLabel: string;
  coachLabel: string;
  /**
   * The payment's amount. From the event payload when it carries one
   * (create/delete snapshots are full rows), otherwise the payment's
   * CURRENT amount — see the changed-keys-only note above.
   */
  amountCents: number | null;
  direction: PaymentDirection | null;
  changes: PaymentFieldChange[];
  /**
   * True when the underlying payment has since been soft-deleted. Such a
   * payment is NOT editable — `getActivePaymentOrThrow` refuses it, and
   * the UI must not offer an affordance the server will reject (SPEC §3).
   */
  paymentDeleted: boolean;
  /**
   * True for the NEWEST event of this payment within the fetched range.
   *
   * The edit affordance hangs off this, and only this. History must not
   * look editable (SPEC §3): putting an "Edit" button on a two-week-old
   * row invites the reading "I am changing what happened then", when in
   * fact every edit acts on the payment's live state and appends a NEW
   * event. Anchoring the affordance to the row that represents current
   * state makes the UI tell the truth about what the button does.
   *
   * "In range" is deliberate and harmless: if a newer event falls outside
   * the filter window, this row is still a valid entry point, because the
   * dialog is seeded from the payment's CURRENT values, not from this
   * row's snapshot.
   */
  isLatestInRange: boolean;
  /**
   * The payment's live values, for seeding the edit dialog. Null when the
   * payment row no longer joins (hard-deleted) — in which case there is
   * nothing to edit.
   */
  current: PaymentCurrentValues | null;
};

/** Live payment state, matching the existing dialog's initial-values shape. */
export type PaymentCurrentValues = {
  id: string;
  coachId: string;
  amountCents: number;
  method: string;
  direction: PaymentDirection;
  paidAt: Date;
  reference: string | null;
  note: string | null;
};

export type PaymentTimelineTotals = {
  /** Recorded in range, coach → PFA. Never netted against the other. */
  recordedCoachToPfaCents: number;
  /** Recorded in range, PFA → coach. Never netted against the other. */
  recordedPfaToCoachCents: number;
  /** How many "recorded" events the totals above are built from. */
  recordedCount: number;
  /**
   * How many of those recorded payments have since been DELETED. They are
   * still counted — they were genuinely recorded in this window — but a
   * total that quietly includes reversed money is a lie by omission, so
   * the UI states the number.
   */
  recordedSinceDeletedCount: number;
};

export type PaymentTimelineData = {
  events: PaymentTimelineEvent[];
  totals: PaymentTimelineTotals;
};

/** The joined row shape the fetch produces. Kept separate so this module stays pure. */
export type PaymentAuditRow = {
  id: string;
  ts: Date;
  action: "create" | "update" | "delete";
  entityId: string;
  diff: unknown;
  actorName: string | null;
  actorEmail: string | null;
  coachName: string | null;
  coachEmail: string | null;
  paymentAmountCents: number | null;
  paymentDirection: PaymentDirection | null;
  paymentDeletedAt: Date | null;
  paymentCoachId: string | null;
  paymentMethod: string | null;
  paymentPaidAt: Date | null;
  paymentReference: string | null;
  paymentNote: string | null;
};

const DIRECTION_LABEL: Record<PaymentDirection, string> = {
  coach_to_pfa: "Coach paid PFA",
  pfa_to_coach: "PFA paid coach",
};

export function paymentDirectionLabel(d: PaymentDirection): string {
  return DIRECTION_LABEL[d];
}

export function buildPaymentTimeline(
  rows: PaymentAuditRow[],
): PaymentTimelineData {
  // Rows arrive newest-first, so the FIRST row seen for a payment is its
  // latest event. Tracked by id rather than by position so the rule holds
  // even if a caller hands over a differently-ordered array.
  const latestSeen = new Set<string>();
  const events = rows.map((row) => {
    const isLatestInRange = !latestSeen.has(row.entityId);
    latestSeen.add(row.entityId);
    return toEvent(row, isLatestInRange);
  });

  let recordedCoachToPfaCents = 0;
  let recordedPfaToCoachCents = 0;
  let recordedCount = 0;
  let recordedSinceDeletedCount = 0;

  for (const e of events) {
    // Totals come from "recorded" events ONLY. Counting every event would
    // triple-count a payment that was recorded, edited and confirmed in
    // the same window — and the number on screen has to be reproducible
    // by reading the rows under it.
    if (e.kind !== "recorded") continue;
    recordedCount += 1;
    if (e.paymentDeleted) recordedSinceDeletedCount += 1;
    if (e.amountCents == null || e.direction == null) continue;
    if (e.direction === "coach_to_pfa") {
      recordedCoachToPfaCents += e.amountCents;
    } else {
      recordedPfaToCoachCents += e.amountCents;
    }
  }

  return {
    events,
    totals: {
      recordedCoachToPfaCents,
      recordedPfaToCoachCents,
      recordedCount,
      recordedSinceDeletedCount,
    },
  };
}

function toEvent(
  row: PaymentAuditRow,
  isLatestInRange: boolean,
): PaymentTimelineEvent {
  const before = readSnapshot(row.diff, "before");
  const after = readSnapshot(row.diff, "after");
  const kind = deriveEventKind(row.action, before, after);

  // Prefer the snapshot the event itself carries, so a deleted payment
  // still reports the amount it had, and an amount edit reports the NEW
  // amount rather than whatever it is today. Fall back to the joined row
  // for events whose diff is changed-keys-only.
  const amountCents =
    readCents(after.amountCents) ??
    readCents(before.amountCents) ??
    row.paymentAmountCents;
  const direction =
    readDirection(after.direction) ??
    readDirection(before.direction) ??
    row.paymentDirection;

  return {
    id: row.id,
    paymentId: row.entityId,
    ts: row.ts,
    kind,
    actorLabel: row.actorName ?? row.actorEmail ?? "Unknown",
    coachLabel: row.coachName ?? row.coachEmail ?? "Unknown coach",
    amountCents,
    direction,
    changes: kind === "edited" ? describeChanges(before, after) : [],
    paymentDeleted: row.paymentDeletedAt !== null,
    isLatestInRange,
    current: readCurrent(row),
  };
}

/**
 * The payment's live values, or null when there is nothing to edit — the
 * row no longer joins, or a required field came back null (which would
 * mean the join missed, since all of these are NOT NULL in the schema).
 */
function readCurrent(row: PaymentAuditRow): PaymentCurrentValues | null {
  if (
    row.paymentCoachId === null ||
    row.paymentAmountCents === null ||
    row.paymentMethod === null ||
    row.paymentDirection === null ||
    row.paymentPaidAt === null
  ) {
    return null;
  }
  return {
    id: row.entityId,
    coachId: row.paymentCoachId,
    amountCents: row.paymentAmountCents,
    method: row.paymentMethod,
    direction: row.paymentDirection,
    paidAt: row.paymentPaidAt,
    reference: row.paymentReference,
    note: row.paymentNote,
  };
}

/**
 * `create` → recorded, `delete` → deleted. An `update` is a CONFIRM when
 * the diff moved status INTO "confirmed"; anything else is an edit.
 *
 * `updatePaymentInternal` never touches `status` (status transitions go
 * through confirm only), so the two cases are disjoint by construction.
 */
export function deriveEventKind(
  action: "create" | "update" | "delete",
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): PaymentEventKind {
  if (action === "create") return "recorded";
  if (action === "delete") return "deleted";
  const becameConfirmed =
    after.status === "confirmed" && before.status !== "confirmed";
  return becameConfirmed ? "confirmed" : "edited";
}

/** Fields worth narrating, in display order. Anything else is ignored. */
const CHANGE_FIELDS: {
  key: string;
  label: string;
  format: (v: unknown) => string | null;
}[] = [
  { key: "amountCents", label: "Amount", format: formatCentsValue },
  { key: "direction", label: "Direction", format: formatDirectionValue },
  { key: "method", label: "Method", format: formatPlain },
  { key: "paidAt", label: "Paid on", format: formatDateValue },
  { key: "reference", label: "Reference", format: formatPlain },
  { key: "note", label: "Note", format: formatPlain },
  { key: "coachId", label: "Coach", format: () => "changed" },
];

function describeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): PaymentFieldChange[] {
  const changes: PaymentFieldChange[] = [];
  for (const field of CHANGE_FIELDS) {
    const hasBefore = field.key in before;
    const hasAfter = field.key in after;
    if (!hasBefore && !hasAfter) continue;
    const from = hasBefore ? field.format(before[field.key]) : null;
    const to = hasAfter ? field.format(after[field.key]) : null;
    // Drop a change that renders identically on both sides.
    //
    // `paidAt` is the reason. The audit diff compares INSTANTS, but the
    // edit dialog is a DATE picker: re-saving a payment without touching
    // the date still moves the stored instant (to PFA midnight), so the
    // diff records a change that is invisible at the precision anyone
    // can see. Rendering "Paid on: 2026-08-08 → 2026-08-08" tells a
    // reader the system changed something and cannot say what, which is
    // worse than silence on a money screen.
    //
    // Nothing real is hidden: every other field here formats losslessly,
    // so an identical render means an identical value.
    if (from === to) continue;
    changes.push({ label: field.label, from, to });
  }
  return changes;
}

/**
 * Pulls `diff.before` / `diff.after` out of the jsonb blob defensively —
 * it is `unknown` at the type level and written by four different call
 * sites, so a missing or malformed side must degrade to "no detail"
 * rather than throw and take the whole page down.
 */
function readSnapshot(
  diff: unknown,
  side: "before" | "after",
): Record<string, unknown> {
  if (typeof diff !== "object" || diff === null) return {};
  const value = (diff as Record<string, unknown>)[side];
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function readCents(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readDirection(v: unknown): PaymentDirection | null {
  return v === "coach_to_pfa" || v === "pfa_to_coach" ? v : null;
}

function formatCentsValue(v: unknown): string | null {
  const cents = readCents(v);
  if (cents === null) return null;
  // Grouped + exact cents, matching every other money surface. A payroll
  // figure rendered "$180000.00" next to one rendered "$1,800.00" reads
  // as two different systems.
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDirectionValue(v: unknown): string | null {
  const d = readDirection(v);
  return d === null ? null : DIRECTION_LABEL[d];
}

function formatPlain(v: unknown): string | null {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v === "" ? "—" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/**
 * Dates inside `diff` are ISO STRINGS — jsonb serialized them on the way
 * in (see lib/audit.ts). Parse defensively and render the PFA calendar
 * day; an unparseable value degrades to null rather than "Invalid Date".
 *
 * ⚠️ `formatPfaDate`, NOT `toISOString().slice(0,10)`. The facility runs
 * on America/Los_Angeles while the stored instant is UTC, so a payment
 * made on the evening of the 3rd is the 4th in UTC — slicing the ISO
 * string would silently report the wrong DAY for every late-afternoon
 * payment, and only west of UTC, which is the entire customer.
 */
function formatDateValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return formatPfaDate(d);
}
