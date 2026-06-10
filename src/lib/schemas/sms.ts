// 1b #25 — input schemas for the coach SMS-reminder setup + toggle actions.
// Follows src/lib/schemas/ convention: server actions parse `input: unknown`
// with these before touching the DB.
//
// The phone is validated only loosely here (non-empty, reasonable length) —
// real E.164 normalization happens in the action via normalizeUsPhoneE164,
// which rejects junk and is what the send path relies on.

import { z } from "zod";

// First-login setup form: the coach provides a phone (only required if they
// opt in) and their opt-in choice. Saving EITHER answer stamps
// sms_prompt_answered_at so the prompt stops showing.
export const saveSmsSetupSchema = z
  .object({
    optIn: z.boolean(),
    phone: z
      .string()
      .trim()
      .max(32, "Phone number is too long")
      .optional(),
  })
  .refine((v) => !v.optIn || Boolean(v.phone && v.phone.length > 0), {
    message: "A phone number is required to receive reminder texts",
    path: ["phone"],
  });

// Later toggle from settings (Worker B UI). Opting in with no phone on file
// is rejected in the action.
export const setSmsOptInSchema = z.object({
  optIn: z.boolean(),
});

export type SaveSmsSetupInput = z.infer<typeof saveSmsSetupSchema>;
export type SetSmsOptInInput = z.infer<typeof setSmsOptInSchema>;
