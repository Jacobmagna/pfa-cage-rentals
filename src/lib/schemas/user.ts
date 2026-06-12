// Convention for src/lib/schemas/: one file per entity, exports
// `create<Entity>Schema` and `update<Entity>Schema` plus the inferred
// TS types (`Create<Entity>Input`, `Update<Entity>Input`). Server
// actions parse their `input: unknown` argument with these schemas
// before touching the DB, so the validation contract lives in one
// place and the action stays terse.
//
// Role is strictly server-derived: every user write hardcodes
// `role: "coach"` and admin elevation happens only via the
// isAdminEmail-gated createUser auth event. These schemas therefore
// do NOT accept a client-supplied `role` — exposing one would be a
// privilege-escalation footgun if a future action ever did
// `.set(updateUserSchema.parse(input))`.

import { z } from "zod";

export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
});

// J9 account-deletion input. Just the coachId — the internal looks
// up the row to capture the before-snapshot for audit.
export const deleteCoachSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type DeleteCoachInput = z.infer<typeof deleteCoachSchema>;
