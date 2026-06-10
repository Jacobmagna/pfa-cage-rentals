// Integration tests for the 1b #25 inbound SMS webhook (STOP / HELP / START).
// Drives the core handler (handleInboundSms) directly against a real Neon dev
// branch and asserts the users.sms_opt_in / sms_opt_out state transitions, plus
// the POST route's dormancy/auth behavior.
//
// The users table isn't truncated by truncateMutables(), so we create our own
// rows with unique keys and clean them up in afterAll.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import {
  handleInboundSms,
  POST,
  INBOUND_WEBHOOK_URL,
} from "@/app/api/sms/inbound/route";
import { computeTwilioSignature } from "@/lib/sms/twilio-signature";

// @/db pulls @/auth → next-auth, which doesn't resolve in vitest's node env.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let coachId: string;
const coachPhoneRaw = "(415) 555-0199"; // normalizes to +14155550199
const coachPhoneE164 = "+14155550199";
const createdUserIds: string[] = [];

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const [coach] = await db
    .insert(users)
    .values({
      email: `sms-inbound-${suffix}@pfa.invalid`,
      name: "SMS Inbound Coach",
      role: "coach",
      phone: coachPhoneRaw,
      smsOptIn: true,
      smsOptOut: false,
    })
    .returning({ id: users.id });
  coachId = coach.id;
  createdUserIds.push(coachId);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // STOP/START write audit_log rows referencing these users (actorUserId),
    // which FK-block the user delete — clear them first.
    await db.delete(auditLog).where(inArray(auditLog.actorUserId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function readState() {
  const [row] = await db
    .select({ smsOptIn: users.smsOptIn, smsOptOut: users.smsOptOut })
    .from(users)
    .where(eq(users.id, coachId));
  return row;
}

describe("handleInboundSms state transitions", () => {
  it("STOP sets smsOptOut=true, smsOptIn=false on the matched coach", async () => {
    const res = await handleInboundSms({ from: coachPhoneRaw, body: "STOP" });
    expect(res.keyword).toBe("stop");
    expect(res.matchedUserIds).toContain(coachId);
    expect(res.twiml).toContain("unsubscribed");
    const state = await readState();
    expect(state.smsOptOut).toBe(true);
    expect(state.smsOptIn).toBe(false);
  });

  it("HELP changes nothing", async () => {
    const before = await readState();
    const res = await handleInboundSms({ from: coachPhoneRaw, body: "HELP" });
    expect(res.keyword).toBe("help");
    expect(res.matchedUserIds).toHaveLength(0);
    // TwiML is XML, so the '&' in the body is escaped to '&amp;'. The
    // recipient still sees a literal '&'. Assert the actual on-the-wire form.
    expect(res.twiml).toContain("Msg &amp; data rates may apply");
    const after = await readState();
    expect(after).toEqual(before);
  });

  it("START sets smsOptOut=false, smsOptIn=true (resubscribe)", async () => {
    const res = await handleInboundSms({ from: coachPhoneRaw, body: "start" });
    expect(res.keyword).toBe("start");
    expect(res.matchedUserIds).toContain(coachId);
    expect(res.twiml).toContain("resubscribed");
    const state = await readState();
    expect(state.smsOptOut).toBe(false);
    expect(state.smsOptIn).toBe(true);
  });

  it("an unknown body is inert (empty TwiML, no state change)", async () => {
    const before = await readState();
    const res = await handleInboundSms({ from: coachPhoneRaw, body: "hello" });
    expect(res.keyword).toBe("none");
    expect(res.twiml).toContain("<Response/>");
    const after = await readState();
    expect(after).toEqual(before);
  });

  it("matches by NORMALIZED phone (raw stored form differs)", async () => {
    // Stored as "(415) 555-0199"; sender uses bare E.164 → still matches.
    const res = await handleInboundSms({ from: coachPhoneE164, body: "STOP" });
    expect(res.matchedUserIds).toContain(coachId);
    // restore
    await handleInboundSms({ from: coachPhoneE164, body: "START" });
  });
});

describe("POST route dormancy + auth", () => {
  const ORIGINAL = process.env.TWILIO_AUTH_TOKEN;
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = ORIGINAL;
  });

  function makeReq(
    params: Record<string, string>,
    headers: Record<string, string> = {},
  ): Request {
    return new Request(INBOUND_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(params).toString(),
    });
  }

  it("is INERT (200 empty TwiML, no state change) when TWILIO_AUTH_TOKEN is unset", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const before = await readState();
    const res = await POST(
      makeReq({ From: coachPhoneRaw, Body: "STOP", MessageSid: "SMtest" }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<Response/>");
    const after = await readState();
    expect(after).toEqual(before); // STOP did NOT take effect (inert)
  });

  it("403s on a bad signature when TWILIO_AUTH_TOKEN is set", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test_token_inbound";
    const before = await readState();
    const res = await POST(
      makeReq(
        { From: coachPhoneRaw, Body: "STOP", MessageSid: "SMtest" },
        { "x-twilio-signature": "not-a-valid-signature" },
      ),
    );
    expect(res.status).toBe(403);
    const after = await readState();
    expect(after).toEqual(before); // rejected → no state change
  });

  it("processes STOP/START with a valid signature when the token is set", async () => {
    process.env.TWILIO_AUTH_TOKEN = "test_token_inbound";
    const stopParams = {
      From: coachPhoneRaw,
      Body: "STOP",
      MessageSid: "SMtest",
    };
    const stopSig = computeTwilioSignature({
      authToken: "test_token_inbound",
      url: INBOUND_WEBHOOK_URL,
      params: stopParams,
    });
    const stopRes = await POST(
      makeReq(stopParams, { "x-twilio-signature": stopSig }),
    );
    expect(stopRes.status).toBe(200);
    let state = await readState();
    expect(state.smsOptOut).toBe(true);
    expect(state.smsOptIn).toBe(false);

    const startParams = {
      From: coachPhoneRaw,
      Body: "START",
      MessageSid: "SMtest2",
    };
    const startSig = computeTwilioSignature({
      authToken: "test_token_inbound",
      url: INBOUND_WEBHOOK_URL,
      params: startParams,
    });
    const startRes = await POST(
      makeReq(startParams, { "x-twilio-signature": startSig }),
    );
    expect(startRes.status).toBe(200);
    state = await readState();
    expect(state.smsOptOut).toBe(false);
    expect(state.smsOptIn).toBe(true);
  });
});
