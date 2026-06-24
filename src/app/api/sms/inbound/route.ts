// 1b #25 — inbound SMS webhook (STOP / HELP / START). Twilio POSTs an
// application/x-www-form-urlencoded body here whenever a coach texts our
// number. We keep the APP's own opt-in/opt-out state in sync with what they
// text so the in-app toggle + reminder cron reflect reality. We send NO reply
// — Twilio's Opt-Out Management owns the STOP/HELP/START confirmations at the
// carrier level (replying here too would double-text on START / bounce on STOP).
//
// DORMANCY: until go-live there is no Twilio number pointed here and no
// TWILIO_AUTH_TOKEN set. With the token UNSET this route is INERT — it returns
// an empty TwiML <Response/> 200 and touches nothing — mirroring the rest of
// the SMS capability (config.ts / cron route stay disabled too). The whole
// repo builds/tests with no SMS env present.
//
// AUTH: when TWILIO_AUTH_TOKEN IS set, we validate Twilio's X-Twilio-Signature
// (src/lib/sms/twilio-signature.ts) before doing anything. The signature is
// computed over the FULL request URL Twilio called; behind Vercel's proxy the
// inbound Host/proto can differ from what Twilio signed, so we reconstruct the
// URL from a FIXED canonical value (INBOUND_WEBHOOK_URL) rather than trusting
// req.url / forwarded headers. Configure Twilio's webhook to that exact URL.

import { inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { users } from "@/db/schema";
import { safeLogAudit } from "@/lib/server/audit-helpers";
import { classifyInboundKeyword } from "@/lib/sms/inbound-keywords";
import { normalizeUsPhoneE164 } from "@/lib/sms/recipients";
import { validateTwilioSignature } from "@/lib/sms/twilio-signature";

export const dynamic = "force-dynamic";

// The canonical, fixed URL Twilio's "A message comes in" webhook MUST be set
// to. Used to reconstruct the signed string (avoids proxy host/proto drift).
//
// MUST be the WWW host: www.pfaengine.com is the primary production domain, so
// the bare apex (pfaengine.com) 307-redirects to www at the Vercel edge. A
// Twilio webhook pointed at the apex would hit that redirect (Twilio doesn't
// reliably follow webhook redirects, and the signature wouldn't match anyway),
// so both this constant AND the Twilio Messaging Service inbound webhook are
// set to the www host that serves the route directly.
export const INBOUND_WEBHOOK_URL =
  "https://www.pfaengine.com/api/sms/inbound";

/** Empty TwiML — a valid "do nothing / no reply" response. */
function emptyTwiml(): string {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>";
}

function xmlResponse(twiml: string, status = 200): NextResponse {
  return new NextResponse(twiml, {
    status,
    headers: { "Content-Type": "text/xml" },
  });
}

// This webhook sends NO user-facing reply. Twilio's Messaging Service Opt-Out
// Management owns the STOP / HELP / START confirmations — it sends them at the
// carrier level (exempt from the opt-out suppression). If this webhook ALSO
// replied, a coach would get TWO texts on START and a bounced (21610) reply on
// STOP. So we stay silent (empty TwiML) and only mirror the coach's own
// opt-in/out state into our DB so the admin UI + reminder cron reflect reality.
// Carrier STOP enforcement is independent: a send to an opted-out number fails
// 21610, which the cron self-heals.

export type InboundResult = {
  twiml: string;
  keyword: ReturnType<typeof classifyInboundKeyword>;
  matchedUserIds: string[];
};

/**
 * Core inbound handler, factored out of the HTTP route so integration tests
 * can drive the DB state changes directly. Validates nothing about auth (the
 * route does that); applies the keyword's state change to every user whose
 * stored phone normalizes to the same E.164 as `from`, and returns the TwiML
 * to reply with.
 */
export async function handleInboundSms(args: {
  from: string | null | undefined;
  body: string | null | undefined;
}): Promise<InboundResult> {
  const keyword = classifyInboundKeyword(args.body);

  // HELP / none never change state and don't need a phone match. We never
  // reply (Twilio Opt-Out Management sends the HELP text); just acknowledge.
  if (keyword === "help" || keyword === "none") {
    return { twiml: emptyTwiml(), keyword, matchedUserIds: [] };
  }

  const normalized = normalizeUsPhoneE164(args.from);
  let matchedUserIds: string[] = [];

  if (normalized) {
    // Stored phones are raw (un-normalized), so we can't filter in SQL by the
    // E.164 form. Pull users that have a phone and match in JS by normalized
    // value. Soft-deleted users are excluded — no point mutating them.
    const candidates = await db
      .select({ id: users.id, phone: users.phone, deletedAt: users.deletedAt })
      .from(users)
      .where(isNull(users.deletedAt));
    matchedUserIds = candidates
      .filter((u) => normalizeUsPhoneE164(u.phone) === normalized)
      .map((u) => u.id);
  }

  if (matchedUserIds.length === 0) {
    // No coach on file with that number — nothing to sync. Twilio still sends
    // the STOP/START confirmation; we stay silent.
    return { twiml: emptyTwiml(), keyword, matchedUserIds: [] };
  }

  if (keyword === "stop") {
    await db
      .update(users)
      .set({ smsOptOut: true, smsOptIn: false })
      .where(inArray(users.id, matchedUserIds));
  } else {
    // start
    await db
      .update(users)
      .set({ smsOptOut: false, smsOptIn: true })
      .where(inArray(users.id, matchedUserIds));
  }

  // Best-effort audit per matched user; never throw out of the webhook.
  for (const id of matchedUserIds) {
    await safeLogAudit(db, {
      actorUserId: id,
      entityType: "user_sms_consent",
      entityId: id,
      action: "update",
      after:
        keyword === "stop"
          ? { smsOptOut: true, smsOptIn: false, via: "sms:STOP" }
          : { smsOptOut: false, smsOptIn: true, via: "sms:START" },
    });
  }

  return { twiml: emptyTwiml(), keyword, matchedUserIds };
}

export async function POST(req: Request) {
  // Parse the urlencoded body into a plain param map (needed both for the
  // keyword and for signature validation).
  const raw = await req.text();
  const form = new URLSearchParams(raw);
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = v;

  const authToken = process.env.TWILIO_AUTH_TOKEN || undefined;

  // DORMANT: no auth token configured → the route is INERT. There is no real
  // Twilio traffic before go-live, so we do nothing and return empty TwiML.
  if (!authToken) {
    return xmlResponse(emptyTwiml());
  }

  // Validate Twilio's signature against the FIXED canonical URL.
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const ok = validateTwilioSignature({
    authToken,
    url: INBOUND_WEBHOOK_URL,
    params,
    signature,
  });
  if (!ok) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const result = await handleInboundSms({
      from: params.From,
      body: params.Body,
    });
    return xmlResponse(result.twiml);
  } catch (err) {
    // Never leak an error to Twilio (it would retry); log + reply inert.
    console.error("[sms-inbound] handler failed", err);
    return xmlResponse(emptyTwiml());
  }
}
