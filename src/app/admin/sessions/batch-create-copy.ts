// The one sentence both admin create dialogs show when a multi-slot create
// THROWS (anything that is not a known refusal; a known refusal comes back
// from createSessionsBatchAction as a result with its own sentence). A
// production build strips a thrown server-action error's message, so the
// dialogs never print err.message. Its own file because form-actions.ts is
// "use server" and may export only async functions.
export const BATCH_CREATE_FALLBACK =
  "Couldn't create those sessions. Try again or adjust the range.";
