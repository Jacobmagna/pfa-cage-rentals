// 1b #25 — PURE inbound-keyword classifier for the SMS webhook. Twilio's
// Advanced Opt-Out handles the canonical carrier keywords, but we ALSO parse
// them ourselves so the app's own opt-in/opt-out state (users.sms_opt_in /
// sms_opt_out) stays in sync with what the coach texted — the in-app toggle
// should visibly reflect a STOP/START even though Twilio also tracks it.
//
// We look at the FIRST whitespace-delimited token only, uppercased + trimmed,
// matching how carriers interpret these keywords (a "STOP please" still means
// STOP).

export type InboundKeyword = "stop" | "help" | "start" | "none";

// Sets per Twilio's standard + advanced opt-out keyword families.
const STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
const HELP_WORDS = new Set(["HELP", "INFO"]);
const START_WORDS = new Set(["START", "YES", "UNSTOP"]);

/**
 * Classify an inbound SMS body into an opt-out / help / opt-in keyword family,
 * or "none". Case-insensitive; only the first token matters. PURE.
 */
export function classifyInboundKeyword(
  body: string | null | undefined,
): InboundKeyword {
  if (!body) return "none";
  const first = body.trim().toUpperCase().split(/\s+/)[0] ?? "";
  if (!first) return "none";
  if (STOP_WORDS.has(first)) return "stop";
  if (HELP_WORDS.has(first)) return "help";
  if (START_WORDS.has(first)) return "start";
  return "none";
}
