// Zod schemas for payment-handle mutations on users + org_settings.
//
// Venmo handle: stored without the @ prefix. Venmo allows a-z, 0-9,
// -, _, 5–30 chars. We accept upper-case input but normalize to lower
// at the boundary so a copy-paste from a profile page doesn't create
// a duplicate.
//
// Zelle contact: free-form email or phone — Zelle doesn't have
// "handles" the way Venmo does; you send to a registered email or
// phone. We validate as either a basic email shape OR a string with
// 10+ digits. Empty / NULL is "not set."

import { z } from "zod";

const VENMO_PATTERN = /^[a-zA-Z0-9_-]{5,30}$/;

const venmoHandle = z
  .string()
  .trim()
  .transform((v) => v.replace(/^@/, ""))
  .refine((v) => v === "" || VENMO_PATTERN.test(v), {
    message: "Venmo handle must be 5–30 chars (letters, numbers, _ or -)",
  })
  .transform((v) => (v === "" ? null : v.toLowerCase()))
  .nullable();

const zelleContact = z
  .string()
  .trim()
  .refine(
    (v) => {
      if (v === "") return true;
      // Email: anything@anything.tld (loose; full RFC isn't worth the cost).
      const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      // Phone: digits + optional +, (), -, space. Require at least 10 digits.
      const digitCount = (v.match(/\d/g) ?? []).length;
      const looksLikePhone = /^[\d\s+().-]+$/.test(v) && digitCount >= 10;
      return looksLikeEmail || looksLikePhone;
    },
    { message: "Zelle contact must be an email or phone number" },
  )
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const updateUserHandlesSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  venmoHandle: venmoHandle.optional(),
  zelleContact: zelleContact.optional(),
});

// Org settings — same handle validators plus the display name.
export const updateOrgSettingsSchema = z.object({
  pfaVenmoHandle: venmoHandle.optional(),
  pfaZelleContact: zelleContact.optional(),
  pfaDisplayName: z
    .string()
    .trim()
    .min(1, "PFA display name can't be empty")
    .max(100)
    .optional(),
});

export type UpdateUserHandlesInput = z.infer<typeof updateUserHandlesSchema>;
export type UpdateOrgSettingsInput = z.infer<typeof updateOrgSettingsSchema>;
