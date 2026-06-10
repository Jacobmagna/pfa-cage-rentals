// 1b #25 — SMS reminder config. Reads the OPTIONAL `SMS_*` / `TWILIO_*` env
// vars LAZILY at call time (mirrors src/lib/data-safe/config.ts), never at
// module load. With the vars unset this returns `{ enabled: false }` and
// never throws — so `npm run build` and the test suite pass without any
// Twilio var present.
//
// The whole capability is DORMANT until go-live: the cron route no-ops when
// `enabled` is false, and the dry-run CLI never needs real creds. `enabled`
// is strictly `SMS_ENABLED === "true"` AND all three Twilio creds present —
// a half-configured env stays disabled rather than half-sending.

export type SmsConfig = {
  enabled: boolean;
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
};

/**
 * Reads the optional SMS_* / TWILIO_* env once, at call time. No throwing on
 * missing values. `enabled` is true ONLY when SMS_ENABLED === "true" AND all
 * three Twilio creds are present, so a partial config never sends.
 */
export function getSmsConfig(): SmsConfig {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || undefined;
  const authToken = process.env.TWILIO_AUTH_TOKEN || undefined;
  const fromNumber = process.env.TWILIO_FROM_NUMBER || undefined;

  const enabled =
    process.env.SMS_ENABLED === "true" &&
    Boolean(accountSid) &&
    Boolean(authToken) &&
    Boolean(fromNumber);

  return { enabled, accountSid, authToken, fromNumber };
}
