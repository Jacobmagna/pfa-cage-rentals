// Convention for src/lib/schemas/: one file per entity, exports
// `create<Entity>Schema` and `update<Entity>Schema` plus the inferred
// TS types (`Create<Entity>Input`, `Update<Entity>Input`). Server
// actions parse their `input: unknown` argument with these schemas
// before touching the DB, so the validation contract lives in one
// place and the action stays terse.
//
// Roles live in src/db/schema.ts (`roleEnum`). The literal union
// here mirrors that enum — Drizzle's `roleEnum.enumValues` is a
// readonly tuple of strings, not a Zod-compatible type, so we
// duplicate the literals rather than pull a value-level dependency
// from db/schema into the schemas layer.

import { z } from "zod";

export const userRoleSchema = z.enum(["coach", "admin"]);

export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
  role: userRoleSchema.default("coach"),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: userRoleSchema.optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
