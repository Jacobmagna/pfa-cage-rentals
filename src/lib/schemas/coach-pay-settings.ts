// QA2 #6 — Zod schema for the per-coach work-pay-mode setting.
//
// payMode "hourly" (the default) keeps today's per-30-min rate
// behavior; perSessionRateCents is irrelevant and may be null. payMode
// "per_session" REQUIRES a positive flat amount (cents). The form layer
// converts the user's dollar input → cents before calling the action;
// this schema validates the already-converted cents and enforces the
// cross-field rule.

import { z } from "zod";

export const coachPayModeSchema = z.enum(["hourly", "per_session"]);

export const updateCoachPaySettingsSchema = z
  .object({
    coachId: z.string().min(1, "coachId is required"),
    payMode: coachPayModeSchema,
    // Cents. Optional/nullable for hourly; required positive for
    // per_session (enforced in the superRefine below).
    perSessionRateCents: z
      .number()
      .int("Per-session amount must be a whole number of cents")
      .positive("Per-session amount must be greater than $0")
      .max(1_000_000, "Per-session amount can't exceed $10,000")
      .nullable()
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.payMode === "per_session" && val.perSessionRateCents == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["perSessionRateCents"],
        message: "Enter a per-session amount when paying per session",
      });
    }
  });

export type UpdateCoachPaySettingsInput = z.infer<
  typeof updateCoachPaySettingsSchema
>;
