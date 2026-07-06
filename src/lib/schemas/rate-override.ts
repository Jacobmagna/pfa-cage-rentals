// Zod schemas for per-coach rate override mutations.
//
// API surface is upsert + delete (no separate create/update): the
// table's composite PK on (coachId, resourceType) means a row either
// exists for that pair or it doesn't — upsert is the natural shape
// and matches how the H3 UI works (one input per resource type).

import { z } from "zod";

const RESOURCE_TYPES = ["cage", "bullpen", "weight_room"] as const;

export const upsertRateOverrideSchema = z
  .object({
    coachId: z.string().min(1, "coachId is required"),
    resourceType: z.enum(RESOURCE_TYPES),
    // Stored in cents. Caller is responsible for the dollars → cents
    // conversion at the form-action layer (one source of truth for
    // currency formatting / rounding semantics — see form-actions.ts).
    ratePer30MinCents: z
      .number()
      .int("Rate must be a whole number of cents")
      .min(1, "Rate must be greater than $0")
      .max(1_000_00, "Rate cannot exceed $1,000 per 30 minutes"),
    // GROUP-RATE (4th tier): OPTIONAL per-coach override of the group
    // weight-room rate. Only accepted when resourceType === "weight_room"
    // (a NON-null value is rejected otherwise by the superRefine below).
    // Three-way semantics:
    //   - OMITTED (undefined) = leave the group override untouched (the
    //     internal preserves any existing value).
    //   - null = explicitly CLEAR the group override → resolution falls back
    //     to the facility group default, then the regular weight-room rate.
    //   - a positive int = set the group override to that cents value.
    groupRatePer30MinCents: z
      .number()
      .int("Group rate must be a whole number of cents")
      .min(1, "Group rate must be greater than $0")
      .max(1_000_00, "Group rate cannot exceed $1,000 per 30 minutes")
      .nullish(),
  })
  .superRefine((val, ctx) => {
    // Only a NON-null group value is type-restricted to weight_room. null (an
    // explicit clear) and undefined (untouched) are valid for ANY type.
    if (
      val.groupRatePer30MinCents != null &&
      val.resourceType !== "weight_room"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groupRatePer30MinCents"],
        message: "A group rate is only valid for the weight_room resource type",
      });
    }
  });

export const deleteRateOverrideSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  resourceType: z.enum(RESOURCE_TYPES),
});

export type UpsertRateOverrideInput = z.infer<typeof upsertRateOverrideSchema>;
export type DeleteRateOverrideInput = z.infer<typeof deleteRateOverrideSchema>;

// Per-(coach, program) PROGRAM rate overrides. Keyed on (coachId,
// programId). DESIGN-1: the override row now carries the per-PROGRAM
// pay MODE — "hourly" (a per-30-min rate, wins over the program's
// defaultRatePer30MinCents) OR "per_session" (a flat per-session
// amount). Exactly one of the two rate columns is required, decided by
// payMode (enforced in the superRefine below). The other may be null.
// The form layer converts the user's dollar input → cents before
// calling the action; this schema validates the already-converted cents.
export const upsertProgramRateOverrideSchema = z
  .object({
    coachId: z.string().min(1, "coachId is required"),
    programId: z.string().min(1, "programId is required"),
    payMode: z.enum(["hourly", "per_session"]),
    // Cents. Required positive (≤ $1,000/30min) when payMode==="hourly";
    // null/omitted otherwise (enforced in the superRefine below).
    ratePer30MinCents: z
      .number()
      .int("Rate must be a whole number of cents")
      .min(1, "Rate must be greater than $0")
      .max(1_000_00, "Rate cannot exceed $1,000 per 30 minutes")
      .nullable()
      .optional(),
    // Cents. Required positive (≤ $10,000) when payMode==="per_session";
    // null/omitted otherwise.
    perSessionRateCents: z
      .number()
      .int("Per-session amount must be a whole number of cents")
      .positive("Per-session amount must be greater than $0")
      .max(1_000_000, "Per-session amount can't exceed $10,000")
      .nullable()
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.payMode === "hourly" && val.ratePer30MinCents == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ratePer30MinCents"],
        message: "Enter an hourly rate when paying hourly",
      });
    }
    if (val.payMode === "per_session" && val.perSessionRateCents == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["perSessionRateCents"],
        message: "Enter a per-session amount when paying per session",
      });
    }
  });

export const deleteProgramRateOverrideSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  programId: z.string().min(1, "programId is required"),
});

export type UpsertProgramRateOverrideInput = z.infer<
  typeof upsertProgramRateOverrideSchema
>;
export type DeleteProgramRateOverrideInput = z.infer<
  typeof deleteProgramRateOverrideSchema
>;
