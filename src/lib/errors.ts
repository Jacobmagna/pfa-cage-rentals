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

export class UseTypeValidationError extends Error {
  readonly code = "USE_TYPE_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "UseTypeValidationError";
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
