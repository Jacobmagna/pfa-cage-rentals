/**
 * Sentry PII scrubber (defense-in-depth).
 *
 * This app stores MINORS' data (names, birthdays). `sendDefaultPii` is already
 * off and Session Replay is disabled, but a thrown error's message could still
 * embed PII — e.g. a validation error echoing an email, phone, or birthday. This
 * `beforeSend` walks the event's free-text fields and redacts likely PII with a
 * conservative set of regexes before the event leaves the process.
 *
 * Hard guarantee: this must NEVER throw and NEVER drop a legit error report.
 * Every entry point is wrapped in try/catch and returns the event unmodified on
 * any error. It returns the event (never null), so error reporting is preserved.
 */
import type { ErrorEvent } from "@sentry/nextjs";

// Conservative, regex-based redaction. Order matters: redact emails before
// phones so the digits inside an email don't get mistaken for a phone number.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// US phone formats incl. "(559) 555-0142", "559-555-0142", "559.555.0142",
// "5595550142", and "+1 559 555 0142". Requires separators or a leading +1/1
// so we don't clobber arbitrary 10-digit IDs too aggressively.
const PHONE_RE =
  /(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]?\d{4}\b/g;
// ISO birthdays / dates: YYYY-MM-DD.
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;

/**
 * Redact likely PII from a single string. Pure; never throws on string input.
 */
function redactString(input: string): string {
  return input
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, "[redacted-phone]")
    .replace(DATE_RE, "[redacted-date]");
}

/**
 * Sentry `beforeSend` hook. Redacts PII from the event's free-text fields
 * (`message`, `exception.values[].value`, and `request` URL/query/headers/data)
 * and returns the (possibly mutated) event. Returns the event unmodified on any
 * error — it can never throw and can never drop an event.
 */
export function scrubPii(event: ErrorEvent): ErrorEvent {
  try {
    if (typeof event.message === "string") {
      event.message = redactString(event.message);
    }

    const values = event.exception?.values;
    if (Array.isArray(values)) {
      for (const ex of values) {
        if (ex && typeof ex.value === "string") {
          ex.value = redactString(ex.value);
        }
      }
    }

    const request = event.request;
    if (request) {
      if (typeof request.url === "string") {
        request.url = redactString(request.url);
      }
      if (typeof request.query_string === "string") {
        request.query_string = redactString(request.query_string);
      }
      if (request.headers && typeof request.headers === "object") {
        for (const key of Object.keys(request.headers)) {
          const val = (request.headers as Record<string, unknown>)[key];
          if (typeof val === "string") {
            (request.headers as Record<string, unknown>)[key] =
              redactString(val);
          }
        }
      }
      if (typeof request.data === "string") {
        request.data = redactString(request.data);
      }
    }

    return event;
  } catch {
    // Never drop a legit error report because the scrubber hit something
    // unexpected. Fall back to sending the event unmodified.
    return event;
  }
}
