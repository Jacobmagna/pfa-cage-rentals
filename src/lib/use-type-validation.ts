// Single source of truth for the cage "use type" rule AND its friendly
// user-facing copy. Pure (no DB / no React) so it can run on both the
// server (session-actions.validateUseType) and the client (the batch
// submit guards in the log-session form + admin session dialog) and be
// unit-tested without a database.
//
// The rule: a cage REQUIRES a use type (hitting or pitching); bullpens
// and weight rooms must NOT have one. This function only decides the
// CAGE-missing case, which is the user-correctable one we surface inline
// — the "wrong useType on a non-cage" mismatch can't happen from the UI
// (the form/dialog only let you pick a useType, never force one onto a
// bullpen) and stays a server-thrown invariant.
//
// Returns the friendly message string when the cage use type is missing,
// or null when the current (resourceType, useType) pair is acceptable to
// submit. Centralizing the copy here keeps the inline batch-error message
// identical to the message the server stamps on UseTypeValidationError.

export type ResourceType = "cage" | "bullpen" | "weight_room";
export type UseType = "hitting" | "pitching" | null | undefined;

// Friendly, user-facing copy for "you picked a cage but left use type
// blank". Kept as a named export so the server throw and the client
// inline guard render the exact same words.
export const CAGE_USE_TYPE_REQUIRED_MESSAGE =
  "Select hitting or pitching for cage sessions.";

// Returns the friendly validation message when a cage is missing its
// use type, otherwise null (= ok to submit). Does NOT enforce the
// "non-cage must be blank" half of the rule — that stays a server-side
// invariant (see session-actions.validateUseType).
export function cageUseTypeError(
  resourceType: ResourceType,
  useType: UseType,
): string | null {
  if (resourceType === "cage" && !useType) {
    return CAGE_USE_TYPE_REQUIRED_MESSAGE;
  }
  return null;
}
