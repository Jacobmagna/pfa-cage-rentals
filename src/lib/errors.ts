// Typed errors thrown from server actions so the UI can render
// friendly, actionable messages. Each has a stable `code` so a
// catch block can switch on it without parsing the message text.
//
// Why subclass Error rather than return a Result<T, E>: server
// actions in Next.js naturally propagate thrown errors through
// the framework's error boundaries. Throws also let helpers
// short-circuit without every caller in the chain returning a
// union — the action body stays linear.
//
// The constructor params double as the fields the UI needs to
// build its message. Don't pre-format the message in the error
// — the UI may want different framings (banner vs toast vs
// confirmation modal). Keep the data structured.

export class SessionOverlapError extends Error {
  readonly code = "SESSION_OVERLAP" as const;
  constructor(
    public readonly resourceName: string,
    public readonly conflictingCoachName: string,
    public readonly conflictingStart: Date,
    public readonly conflictingEnd: Date,
  ) {
    super(`${resourceName} is already booked by ${conflictingCoachName}`);
    this.name = "SessionOverlapError";
  }
}

export class BlockedTimeError extends Error {
  readonly code = "BLOCKED_TIME" as const;
  constructor(
    public readonly resourceName: string,
    public readonly blockReason: string,
  ) {
    super(`${resourceName} is blocked: ${blockReason}`);
    this.name = "BlockedTimeError";
  }
}

export class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND" as const;
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}

export class ResourceNotFoundError extends Error {
  readonly code = "RESOURCE_NOT_FOUND" as const;
  constructor(public readonly resourceId: string) {
    super(`Resource ${resourceId} not found`);
    this.name = "ResourceNotFoundError";
  }
}

export class BlockNotFoundError extends Error {
  readonly code = "BLOCK_NOT_FOUND" as const;
  constructor(public readonly blockId: string) {
    super(`Blocked time ${blockId} not found`);
    this.name = "BlockNotFoundError";
  }
}

// Block-vs-block overlap on the same resource — caught by the
// `blocked_times` EXCLUDE constraint (SQLSTATE 23P01) and translated
// to a friendly message. Different from BlockedTimeError (which is
// "a session overlaps with an existing block").
export class BlockOverlapError extends Error {
  readonly code = "BLOCK_OVERLAP" as const;
  constructor(
    public readonly resourceName: string,
    public readonly conflictingReason: string,
    public readonly conflictingStart: Date,
    public readonly conflictingEnd: Date,
  ) {
    super(`${resourceName} is already blocked: ${conflictingReason}`);
    this.name = "BlockOverlapError";
  }
}

// Trying to create a block over an existing session. App-layer
// check because Postgres EXCLUDE can't span tables.
export class RateOverrideNotFoundError extends Error {
  readonly code = "RATE_OVERRIDE_NOT_FOUND" as const;
  constructor(
    public readonly coachId: string,
    public readonly resourceType: string,
  ) {
    super(`No override exists for that coach + resource type yet.`);
    this.name = "RateOverrideNotFoundError";
  }
}

export class ProgramRateOverrideNotFoundError extends Error {
  readonly code = "PROGRAM_RATE_OVERRIDE_NOT_FOUND" as const;
  constructor(
    public readonly coachId: string,
    public readonly programId: string,
  ) {
    super(`No override exists for that coach + program yet.`);
    this.name = "ProgramRateOverrideNotFoundError";
  }
}

export class PaymentNotFoundError extends Error {
  readonly code = "PAYMENT_NOT_FOUND" as const;
  constructor(public readonly paymentId: string) {
    super(`Payment ${paymentId} not found`);
    this.name = "PaymentNotFoundError";
  }
}

export class PaymentAlreadyConfirmedError extends Error {
  readonly code = "PAYMENT_ALREADY_CONFIRMED" as const;
  constructor(public readonly paymentId: string) {
    super(`Payment ${paymentId} is already confirmed`);
    this.name = "PaymentAlreadyConfirmedError";
  }
}

export class CoachNotFoundError extends Error {
  readonly code = "COACH_NOT_FOUND" as const;
  constructor(public readonly coachId: string) {
    super(`Coach ${coachId} not found`);
    this.name = "CoachNotFoundError";
  }
}

// Refused J9 delete because the target is an admin. Admin lifecycle
// is managed via the hardcoded `isAdminEmail` allowlist, not the
// coach-detail UI.
export class CannotDeleteAdminError extends Error {
  readonly code = "CANNOT_DELETE_ADMIN" as const;
  constructor(public readonly coachId: string) {
    super(`Cannot delete an admin via the coach-delete flow`);
    this.name = "CannotDeleteAdminError";
  }
}

// Soft-delete is idempotent in spirit but we want callers to know
// they hit an already-anonymized row (so the UI doesn't pretend it
// just happened).
export class CoachAlreadyDeletedError extends Error {
  readonly code = "COACH_ALREADY_DELETED" as const;
  constructor(public readonly coachId: string) {
    super(`Coach ${coachId} is already deleted`);
    this.name = "CoachAlreadyDeletedError";
  }
}

// QA-2: a mutating server action reachable from the coach-detail page
// was called against an ARCHIVED (soft-deleted) coach. The detail page
// now RENDERS for archived coaches in read-only mode, so the UI hides
// every editor — but this is the server-side backstop (defense in depth):
// any write whose TARGET coach has a non-null deletedAt is rejected here,
// even a forged direct RPC call. Restore is the only mutation allowed on
// an archived coach, and it doesn't go through this guard.
export class CoachArchivedError extends Error {
  readonly code = "COACH_ARCHIVED" as const;
  constructor(public readonly coachId: string) {
    super(`Coach ${coachId} is archived — restore them before making changes`);
    this.name = "CoachArchivedError";
  }
}

// Merge rejected because the source isn't a synthetic import user.
// Only @imported.local pseudo-coaches can be merged — merging two
// real coaches would conflate human-vs-human identity changes that
// belong in a separate flow.
export class MergeSourceNotSyntheticError extends Error {
  readonly code = "MERGE_SOURCE_NOT_SYNTHETIC" as const;
  constructor(public readonly sourceId: string) {
    super(`Source coach is not a synthetic import user`);
    this.name = "MergeSourceNotSyntheticError";
  }
}

export class MergeTargetSameAsSourceError extends Error {
  readonly code = "MERGE_TARGET_SAME_AS_SOURCE" as const;
  constructor(public readonly id: string) {
    super(`Merge source and target must differ`);
    this.name = "MergeTargetSameAsSourceError";
  }
}

// Athlete merge (#17 roster dedup) listed the survivor among its own
// sources — a no-op that would delete the record being kept. Rejected
// before any write.
export class MergeAthleteSameError extends Error {
  readonly code = "MERGE_ATHLETE_SAME" as const;
  constructor(public readonly athleteId: string) {
    super(`Merge survivor cannot also be a source athlete`);
    this.name = "MergeAthleteSameError";
  }
}

// Hour-log create referenced a program id that doesn't exist (stale
// client option, or a direct RPC call with a bogus id).
export class ProgramNotFoundError extends Error {
  readonly code = "PROGRAM_NOT_FOUND" as const;
  constructor(public readonly programId: string) {
    super(`Program ${programId} not found`);
    this.name = "ProgramNotFoundError";
  }
}

// Program create/update hit the `programs_name_unique` constraint —
// another program already owns that name. The submitted name rides
// along so the UI can echo it in the banner.
export class ProgramNameTakenError extends Error {
  readonly code = "PROGRAM_NAME_TAKEN" as const;
  constructor(public readonly name: string) {
    super(`A program named "${name}" already exists`);
    this.name = "ProgramNameTakenError";
  }
}

// Hour-log create targeted a retired (soft-deleted) program. Programs
// are never hard-deleted — they're flipped to active = false — so a
// stale form option could still point at one.
export class ProgramInactiveError extends Error {
  readonly code = "PROGRAM_INACTIVE" as const;
  constructor(
    public readonly programId: string,
    public readonly programName: string,
  ) {
    super(`${programName} is no longer active`);
    this.name = "ProgramInactiveError";
  }
}

// Admin hour-log edit/delete referenced an hour_logs id that doesn't
// exist (stale client row, or a direct RPC call with a bogus id).
export class HourLogNotFoundError extends Error {
  readonly code = "HOUR_LOG_NOT_FOUND" as const;
  constructor(public readonly hourLogId: string) {
    super(`Hour log ${hourLogId} not found`);
    this.name = "HourLogNotFoundError";
  }
}

// 1b security B: a manual hour-log was anomalous (unscheduled / wrong-time /
// over-logged) and the coach has NOT yet acknowledged sending it to an admin
// for approval. Thrown by the manual write path BEFORE any insert; the coach
// form catches this to show the "send for approval or go back and edit"
// warning. `reason` names the anomaly kind; `message` is the human copy.
export class HeldLogReviewRequiredError extends Error {
  readonly code = "HELD_LOG_REVIEW_REQUIRED" as const;
  constructor(
    public readonly reason: "unscheduled" | "wrong_time" | "over_logged",
    message: string,
  ) {
    super(message);
    this.name = "HeldLogReviewRequiredError";
  }
}

// 1b security B: an admin approved/rejected a held hour-log that isn't `held`
// (missing, or already approved/rejected by another tab). Mirrors
// HourLogNotFoundError's shape.
export class HeldHourLogNotFoundError extends Error {
  readonly code = "HELD_HOUR_LOG_NOT_FOUND" as const;
  constructor(public readonly hourLogId: string) {
    super(`Held hour log ${hourLogId} not found or already resolved`);
    this.name = "HeldHourLogNotFoundError";
  }
}

// Admin accept-with-time-edit shifted a needs-review log onto the exact
// (coach, program, start, end) of an already-logged hour — caught via the
// hour_logs_coach_program_start_end_unique index (SQLSTATE 23505) and
// translated to a friendly message. Mirrors HourLogNotFoundError's shape.
export class DuplicateHourLogError extends Error {
  readonly code = "DUPLICATE_HOUR_LOG" as const;
  constructor() {
    super(
      "Another logged hour already covers those exact times for this coach and program.",
    );
    this.name = "DuplicateHourLogError";
  }
}

// Admin tried to reject a needs-review hour log without supplying a
// reason. The coach must be told WHY their hour was rejected, so a
// non-empty reason is mandatory. Mirrors HeldHourLogNotFoundError's shape.
export class RejectReasonRequiredError extends Error {
  readonly code = "REJECT_REASON_REQUIRED" as const;
  constructor() {
    super("A reason is required to reject an hour.");
    this.name = "RejectReasonRequiredError";
  }
}

// Admin resolve referenced a program_block_coach_flags id that doesn't
// exist (stale client row, or a direct RPC call with a bogus id).
// Mirrors HourLogNotFoundError's shape.
export class BlockFlagNotFoundError extends Error {
  readonly code = "BLOCK_FLAG_NOT_FOUND" as const;
  constructor(public readonly flagId: string) {
    super(`Block flag ${flagId} not found`);
    this.name = "BlockFlagNotFoundError";
  }
}

// Program-schedule-block edit/delete referenced a
// program_schedule_blocks id that doesn't exist (stale client row, or
// a direct RPC call with a bogus id). Mirrors BlockNotFoundError.
export class ProgramScheduleBlockNotFoundError extends Error {
  readonly code = "PROGRAM_SCHEDULE_BLOCK_NOT_FOUND" as const;
  constructor(public readonly blockId: string) {
    super(`Program schedule block ${blockId} not found`);
    this.name = "ProgramScheduleBlockNotFoundError";
  }
}

// RECUR-a: an edit/cancel referenced a program_schedule_series id that
// doesn't exist (stale client row or a bogus RPC call). Mirrors
// ProgramScheduleBlockNotFoundError.
export class ProgramScheduleSeriesNotFoundError extends Error {
  readonly code = "PROGRAM_SCHEDULE_SERIES_NOT_FOUND" as const;
  constructor(public readonly seriesId: string) {
    super(`Program schedule series ${seriesId} not found`);
    this.name = "ProgramScheduleSeriesNotFoundError";
  }
}

// RECUR-a: cancel-occurrence was called on a block that is NOT part of a
// series (seriesId is null — a one-off block). One-off blocks are
// deleted via the existing single-block delete path, not cancelled.
export class NotASeriesOccurrenceError extends Error {
  readonly code = "NOT_A_SERIES_OCCURRENCE" as const;
  constructor(public readonly blockId: string) {
    super(`Block ${blockId} is not a recurring-series occurrence`);
    this.name = "NotASeriesOccurrenceError";
  }
}

// Coach-side shift hand-off / no-cover: the acting coach is not a member
// of the block they tried to give away or mark unworked (stale client row,
// already handed off, or a direct RPC call with someone else's block).
export class NotAssignedToBlockError extends Error {
  readonly code = "NOT_ASSIGNED_TO_BLOCK" as const;
  constructor(
    public readonly blockId: string,
    public readonly coachId: string,
  ) {
    super(`Coach ${coachId} is not assigned to block ${blockId}`);
    this.name = "NotAssignedToBlockError";
  }
}

// Coach-side shift hand-off / no-cover: the block already has a posted
// hour-log for this coach, so it can't be given away or marked unworked
// (it already happened and was logged). The coach edits the log instead.
export class BlockAlreadyLoggedError extends Error {
  readonly code = "BLOCK_ALREADY_LOGGED" as const;
  constructor(public readonly blockId: string) {
    super(`Block ${blockId} already has a logged hour for this coach`);
    this.name = "BlockAlreadyLoggedError";
  }
}

// Coach-side shift hand-off: the chosen recipient isn't a valid hand-off
// target — not an active coach, or the same coach trying to hand off to
// themselves.
export class InvalidHandoffTargetError extends Error {
  readonly code = "INVALID_HANDOFF_TARGET" as const;
  constructor(public readonly toCoachId: string) {
    super(`${toCoachId} is not a valid hand-off recipient`);
    this.name = "InvalidHandoffTargetError";
  }
}

// BLOCK-RECUR: edit/cancel referenced a blocked_times_series id that doesn't
// exist (stale client row or a bogus RPC call). Mirrors
// ProgramScheduleSeriesNotFoundError.
export class BlockedTimeSeriesNotFoundError extends Error {
  readonly code = "BLOCKED_TIME_SERIES_NOT_FOUND" as const;
  constructor(public readonly seriesId: string) {
    super(`Blocked-time series ${seriesId} not found`);
    this.name = "BlockedTimeSeriesNotFoundError";
  }
}

// Athlete edit/delete/assign referenced an athletes id that doesn't
// exist (stale client row, or a direct RPC call with a bogus id).
export class AthleteNotFoundError extends Error {
  readonly code = "ATHLETE_NOT_FOUND" as const;
  constructor(public readonly athleteId: string) {
    super(`Athlete ${athleteId} not found`);
    this.name = "AthleteNotFoundError";
  }
}

// Refused to hard-delete an athlete that still has attendance_records.
// athletes has no soft-delete column, so deleting would cascade away
// the attendance history — we guard instead (DEC-20) and surface this.
export class AthleteHasRecordsError extends Error {
  readonly code = "ATHLETE_HAS_RECORDS" as const;
  constructor(
    public readonly athleteId: string,
    public readonly recordCount: number,
  ) {
    super(
      `Athlete ${athleteId} has ${recordCount} attendance record(s) and can't be deleted`,
    );
    this.name = "AthleteHasRecordsError";
  }
}

// Attendance submit hit a program with no athletes on its roster.
// Taking attendance for an empty roster is meaningless (and the
// submit schema requires at least one record), so we refuse and tell
// the coach to enroll athletes first.
export class AttendanceEmptyRosterError extends Error {
  readonly code = "ATTENDANCE_EMPTY_ROSTER" as const;
  constructor(public readonly programId: string) {
    super(`No athletes are assigned to this program yet`);
    this.name = "AttendanceEmptyRosterError";
  }
}

// 1b security: a coach tried to hard-delete or edit a billable field
// (resource/date/start/end) of a PAST cage rental (startAt <= now).
// Past charges are money the coach owes PFA — they can't be erased
// unilaterally, only via an admin-approved removal request.
export class PastRentalImmutableError extends Error {
  readonly code = "PAST_RENTAL_IMMUTABLE" as const;
  constructor(public readonly sessionId: string) {
    super(
      "Past rentals can't be changed directly — submit a removal request.",
    );
    this.name = "PastRentalImmutableError";
  }
}

// 1b security: a coach filed a removal request for a session that
// already has a pending request. One open request per session.
export class RemovalRequestExistsError extends Error {
  readonly code = "REMOVAL_REQUEST_EXISTS" as const;
  constructor(public readonly sessionId: string) {
    super(`A removal request is already pending for this rental`);
    this.name = "RemovalRequestExistsError";
  }
}

// 1b security: an admin approved/denied a removal request that doesn't
// exist or is no longer pending (already resolved, or a stale/bogus id).
export class RemovalRequestNotFoundError extends Error {
  readonly code = "REMOVAL_REQUEST_NOT_FOUND" as const;
  constructor(public readonly requestId: string) {
    super(`Removal request ${requestId} not found or already resolved`);
    this.name = "RemovalRequestNotFoundError";
  }
}

export class BlockConflictsWithSessionError extends Error {
  readonly code = "BLOCK_CONFLICTS_WITH_SESSION" as const;
  constructor(
    public readonly resourceName: string,
    public readonly coachName: string,
    public readonly conflictingStart: Date,
    public readonly conflictingEnd: Date,
  ) {
    super(
      `${resourceName} already has a session by ${coachName} during that range`,
    );
    this.name = "BlockConflictsWithSessionError";
  }
}

// 1b #25 — the coach tried to enable SMS reminders without a valid phone
// number on file (or supplied a number we couldn't normalize to E.164).
export class SmsPhoneRequiredError extends Error {
  readonly code = "SMS_PHONE_REQUIRED" as const;
  constructor() {
    super("A valid phone number is required to receive reminder texts");
    this.name = "SmsPhoneRequiredError";
  }
}
