// 0r — admin RECONCILIATION-RESOLUTION input schema.
//
// `wrong_time` (the right coach, a different window) is derived live by the
// engine and nothing could previously clear it. The resolution MAKES THE
// SCHEDULE MATCH WHAT ACTUALLY HAPPENED, so the status then goes green
// through the ordinary engine with no stored "resolved" state to drift.
//
// 📌 `reassignBlockToLoggedCoachSchema` lived here until 2026-08-25 and was
// removed with the reassign action — see `block-recon-actions.ts`'s header
// for why. `wrong_coach` is now resolved by approving the covering coach's
// log, which JOINS him to the block rather than swapping membership.
//
// This action is taken by an ADMIN about another person, so the coach id
// arrives from the client and is validated here before any DB work. The
// action layer re-derives everything that matters from the database;
// nothing on this object is trusted as evidence.

import { z } from "zod";

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
