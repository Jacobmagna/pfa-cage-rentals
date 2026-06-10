// 1b #25 — thin Twilio REST client (no `twilio` npm dep; plain `fetch`) plus
// the pure message renderer. The whole module is DORMANT until go-live —
// nothing calls sendSms unless the capability is enabled.
//
// On a successful send Twilio returns the message resource as JSON; we read
// its `sid`. The ONE error code we special-case is 21610 ("recipient has
// opted out / is on the STOP list"): callers flip that coach's
// `sms_opt_out=true` so we never re-text them. Every other failure surfaces
// as an SmsSendError with the Twilio code + message so the reminder-log row
// records it.

// Twilio's "recipient opted out (STOP)" error code. When we hit it, the
// coach is on Twilio's suppression list — mirror it to users.sms_opt_out.
export const TWILIO_OPT_OUT_CODE = 21610;

/**
 * The reminder body. EXACT copy — do NOT change wording (it's locked scope).
 * `link` is the deep link to the coach Work Log.
 */
export function renderReminderBody(link: string): string {
  return `PFA Engine: You had work scheduled yesterday that hasn't been logged. Please log it: ${link} Reply STOP to opt out.`;
}

export class SmsSendError extends Error {
  readonly code = "SMS_SEND_FAILED" as const;
  constructor(
    public readonly twilioCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = "SmsSendError";
  }

  /** True when Twilio reported the recipient is opted out (STOP). */
  get isOptOut(): boolean {
    return this.twilioCode === TWILIO_OPT_OUT_CODE;
  }
}

export type SendSmsArgs = {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
};

/**
 * POSTs one message to the Twilio Messages API with HTTP Basic auth
 * (accountSid:authToken). Returns `{ sid }` on success; throws SmsSendError
 * on any non-2xx response (carrying Twilio's numeric `code` when present, so
 * the caller can detect the opt-out code 21610).
 */
export async function sendSms(args: SendSmsArgs): Promise<{ sid: string }> {
  const { accountSid, authToken, from, to, body } = args;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    accountSid,
  )}/Messages.json`;

  const auth = Buffer.from(`${accountSid}:${authToken}`, "utf8").toString(
    "base64",
  );

  const form = new URLSearchParams();
  form.set("To", to);
  form.set("From", from);
  form.set("Body", body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Twilio always returns JSON; a parse failure on a non-2xx is still an
    // error we surface below.
  }

  if (!res.ok) {
    const payload = (json ?? {}) as { code?: number; message?: string };
    throw new SmsSendError(
      typeof payload.code === "number" ? payload.code : null,
      payload.message ?? `Twilio responded ${res.status}`,
    );
  }

  const payload = (json ?? {}) as { sid?: string };
  if (!payload.sid) {
    throw new SmsSendError(null, "Twilio response missing message sid");
  }
  return { sid: payload.sid };
}
