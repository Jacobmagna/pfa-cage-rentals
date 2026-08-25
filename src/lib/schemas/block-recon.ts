// 0r — admin RECONCILIATION-RESOLUTION input schemas.
//
// Two red states the engine derives live and nothing could previously clear:
// `wrong_coach` (someone else worked it) and `wrong_time` (the right coach,
// a different window). Both resolutions share one idea — MAKE THE SCHEDULE
// MATCH WHAT ACTUALLY HAPPENED — so the status then goes green through the
// ordinary engine with no stored "resolved" state to drift.
//
// Unlike the coach-side hand-off (`block-handoff.ts`), where the acting
// coach is always the session user and therefore never client-supplied,
// this action is taken by an ADMIN about two OTHER people — so both coach
// ids arrive from the client and both are validated here before any DB
// work. The action layer re-derives everything that matters (membership,
// and whether `toCoachId` actually logged the block) from the database;
// nothing on this object is trusted as evidence.

import { z } from "zod";

export const reassignBlockToLoggedCoachSchema = z.object({
  blockId: z.string().min(1),
  // The scheduled coach who did NOT work it (the one currently rendering
  // red). Sent explicitly rather than inferred from the block's primary so
  // a multi-coach block reassigns the intended membership row.
  fromCoachId: z.string().min(1),
  // The coach who actually logged the work — the reconciliation engine's
  // `loggedBy.coachId` for this block.
  toCoachId: z.string().min(1),
});

export type ReassignBlockToLoggedCoachInput = z.infer<
  typeof reassignBlockToLoggedCoachSchema
>;

// 0r(4) — "match the schedule to what happened" for a `wrong_time` block.
//
// 🔴 Deliberately carries NO times. The action re-derives the logged window
// from the database by running the SAME reconciliation engine the banner
// rendered from, so a stale or hand-edited client cannot move a scheduled
// block to a window nobody worked. The client says WHICH block and WHICH
// coach; the server decides what the times become.
export const matchBlockToLoggedTimesSchema = z.object({
  blockId: z.string().min(1),
  coachId: z.string().min(1),
});

export type MatchBlockToLoggedTimesInput = z.infer<
  typeof matchBlockToLoggedTimesSchema
>;
