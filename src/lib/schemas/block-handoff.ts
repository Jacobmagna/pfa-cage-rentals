// Coach-side shift hand-off / no-cover input schemas (W3-handoff).
//
// A coach who was scheduled for a work block but didn't take it can either
// HAND IT OFF to another coach (membership moves to them) or mark it as
// NOT WORKED with no cover (a 'cancelled' flag that surfaces in the admin
// needs-review queue). These schemas validate the public server actions'
// `input: unknown` before any DB work; the acting coach is always the
// session user (never client-supplied), so only the block + recipient ids
// are accepted here.

import { z } from "zod";

export const reassignBlockSchema = z.object({
  blockId: z.string().min(1),
  toCoachId: z.string().min(1),
});

export const cancelBlockSchema = z.object({
  blockId: z.string().min(1),
  // Optional "why it didn't happen" note, mirrors the cage removal-request
  // reason. Trimmed-empty becomes null at the action layer.
  note: z.string().max(500).optional(),
});

export type ReassignBlockInput = z.infer<typeof reassignBlockSchema>;
export type CancelBlockInput = z.infer<typeof cancelBlockSchema>;
