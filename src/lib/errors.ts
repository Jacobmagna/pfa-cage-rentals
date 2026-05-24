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
