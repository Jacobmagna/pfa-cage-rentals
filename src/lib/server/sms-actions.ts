// 1b #25 — internal mutation logic for the coach SMS-reminder setup + toggle.
// Lives outside any "use server" file because Next.js exposes every async
// export from "use server" files as a public RPC endpoint — and these take
// the actor as a parameter, so exposing them would let anyone forge another
// coach's identity. The public wrappers in src/app/coach/actions.ts call
// these with requireSession() and pin the actor's own id.
//
// Coach-scoped: every write targets `actor.id` only — a client-supplied
// coachId is never read, so a coach can never change another coach's SMS
// settings (no IDOR).
//
// DORMANT-SAFE: these only flip per-coach preference columns; they do not
// send anything and work fine with no Twilio env present.

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users } from "@/db/schema";
import type { AuthedSession } from "@/lib/authz";
import { logAudit } from "@/lib/audit";
import { SmsPhoneRequiredError } from "@/lib/errors";
import { saveSmsSetupSchema, setSmsOptInSchema } from "@/lib/schemas/sms";
import { normalizeUsPhoneE164 } from "@/lib/sms/recipients";

export type SmsSettings = {
  optIn: boolean;
  optOut: boolean;
  phone: string | null;
  promptAnswered: boolean;
};

/**
 * First-login setup save. Stores the coach's phone (normalized to E.164 when
 * provided) + their opt-in choice, and stamps sms_prompt_answered_at so the
 * one-time setup prompt stops showing — whether they opted in or not.
 *
 * Opting in requires a phone that normalizes; otherwise throws
 * SmsPhoneRequiredError. Turning the opt-IN on stamps sms_consent_at; it is
 * left untouched when opting out (kept as the historical first-consent
 * marker). A coach who explicitly opts in here also clears any prior
 * sms_opt_out (this is a fresh, deliberate opt-in).
 */
export async function saveSmsSetupInternal(
  actor: AuthedSession["user"],
  input: unknown,
): Promise<SmsSettings> {
  const { optIn, phone } = saveSmsSetupSchema.parse(input);

  let normalizedPhone: string | null = null;
  if (phone && phone.length > 0) {
    normalizedPhone = normalizeUsPhoneE164(phone);
    if (!normalizedPhone) throw new SmsPhoneRequiredError();
  }

  if (optIn && !normalizedPhone) {
    throw new SmsPhoneRequiredError();
  }

  const [before] = await db
    .select({
      phone: users.phone,
      smsOptIn: users.smsOptIn,
      smsOptOut: users.smsOptOut,
    })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);

  const now = new Date();
  const set: {
    smsOptIn: boolean;
    smsPromptAnsweredAt: Date;
    phone?: string;
    smsConsentAt?: Date;
    smsOptOut?: boolean;
  } = {
    smsOptIn: optIn,
    smsPromptAnsweredAt: now,
  };
  if (normalizedPhone) set.phone = normalizedPhone;
  if (optIn) {
    set.smsConsentAt = now;
    // A deliberate opt-in clears a stale carrier opt-out.
    set.smsOptOut = false;
  }

  await db.update(users).set(set).where(eq(users.id, actor.id));

  await logAudit(db, {
    actorUserId: actor.id,
    entityType: "user",
    entityId: actor.id,
    action: "update",
    before: {
      smsOptIn: before?.smsOptIn ?? false,
      phone: before?.phone ?? null,
    },
    after: { smsOptIn: optIn, phone: normalizedPhone ?? before?.phone ?? null },
  });

  return {
    optIn,
    optOut: optIn ? false : (before?.smsOptOut ?? false),
    phone: normalizedPhone ?? before?.phone ?? null,
    promptAnswered: true,
  };
}

/**
 * Later opt-in toggle from settings. Opting in requires a valid phone already
 * on file (normalizes the stored value); otherwise throws
 * SmsPhoneRequiredError. Opting in stamps sms_consent_at + clears a stale
 * carrier opt-out; opting out just flips smsOptIn off.
 */
export async function setSmsOptInInternal(
  actor: AuthedSession["user"],
  input: unknown,
): Promise<SmsSettings> {
  const { optIn } = setSmsOptInSchema.parse(input);

  const [before] = await db
    .select({
      phone: users.phone,
      smsOptIn: users.smsOptIn,
      smsOptOut: users.smsOptOut,
    })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);

  const normalizedPhone = normalizeUsPhoneE164(before?.phone);
  if (optIn && !normalizedPhone) {
    throw new SmsPhoneRequiredError();
  }

  const now = new Date();
  const set: {
    smsOptIn: boolean;
    smsConsentAt?: Date;
    smsOptOut?: boolean;
  } = { smsOptIn: optIn };
  if (optIn) {
    set.smsConsentAt = now;
    set.smsOptOut = false;
  }

  await db.update(users).set(set).where(eq(users.id, actor.id));

  await logAudit(db, {
    actorUserId: actor.id,
    entityType: "user",
    entityId: actor.id,
    action: "update",
    before: { smsOptIn: before?.smsOptIn ?? false },
    after: { smsOptIn: optIn },
  });

  return {
    optIn,
    optOut: optIn ? false : (before?.smsOptOut ?? false),
    phone: before?.phone ?? null,
    promptAnswered: true,
  };
}
