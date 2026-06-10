// 1b #25 — Twilio X-Twilio-Signature validation, implemented WITHOUT the
// `twilio` npm dep (node:crypto only). Twilio signs each inbound webhook so
// we can prove a POST actually came from Twilio and not a spoofer.
//
// The algorithm (per Twilio's "Validating Signatures" docs):
//   1. Start with the FULL request URL exactly as Twilio called it (scheme,
//      host, path, and any query string).
//   2. Sort the POST body params by key (string sort). For each, append the
//      key immediately followed by its value (no separators).
//   3. HMAC-SHA1 the resulting string with your account's auth token as the
//      key, then base64-encode the digest.
//   4. Compare (timing-safe) to the value Twilio sent in X-Twilio-Signature.
//
// PURE + deterministic: the caller supplies the url, params, signature, and
// authToken. No env, no I/O.

import { createHmac, timingSafeEqual } from "node:crypto";

export type ValidateTwilioSignatureArgs = {
  /** Account auth token (Twilio Console → Account Info). */
  authToken: string;
  /** The full request URL exactly as Twilio invoked it (incl. query string). */
  url: string;
  /** The POST form params (application/x-www-form-urlencoded). */
  params: Record<string, string>;
  /** The value of the X-Twilio-Signature header. */
  signature: string;
};

/**
 * Computes the expected Twilio signature for a request. Exported for tests /
 * debugging; production code uses validateTwilioSignature. PURE.
 */
export function computeTwilioSignature(args: {
  authToken: string;
  url: string;
  params: Record<string, string>;
}): string {
  const { authToken, url, params } = args;
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest(
    "base64",
  );
}

/**
 * True iff `signature` is a valid Twilio signature for (url, params) under
 * `authToken`. Timing-safe; returns false (never throws) on any mismatch,
 * including a malformed/empty signature. PURE.
 */
export function validateTwilioSignature(
  args: ValidateTwilioSignatureArgs,
): boolean {
  const { authToken, url, params, signature } = args;
  if (!authToken || !signature) return false;

  const expected = computeTwilioSignature({ authToken, url, params });

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // timingSafeEqual throws on length mismatch — guard first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
