// The password gate for the short display URL (`/video`).
//
// 🔴 WHY THIS EXISTS ALONGSIDE token.ts, AND WHY IT IS NOT A REPLACEMENT FOR IT.
// The tokenised route (`/display/schedule?key=…`) puts the secret IN the URL,
// which is unguessable but unusable: nobody types a 48-character key into a
// television remote, and the AV tech would have to get it byte-perfect. Mark
// asked for `pfaengine.com/video` — and a URL that short cannot carry a secret,
// so the secret has to move somewhere else. It moves to a PASSWORD BOX.
//
// 🔴 THE CONSTRAINT THAT SHAPES EVERYTHING HERE: A LOGIN SCREEN ON THE WALL IS
// THE FAILURE THIS WHOLE FEATURE EXISTS TO PREVENT. That is why token.ts
// rejected a real Auth.js session in the first place — a session that dies at
// 2 AM leaves a sign-in page glowing over the cages all morning and nobody
// walks over to fix it (maintenance discipline rule 22 is this repo getting
// bitten by exactly that). So:
//
//   · the cookie is deliberately LONG-LIVED (a year), not a session cookie;
//   · it is re-issued on every successful unlock, so a TV that is touched
//     occasionally never ages out;
//   · and when it IS lost, recovery is a short password Mark can retype from
//     memory rather than a 48-character token he would have to be sent.
//
// 🔴 THAT LAST POINT IS THE REAL ARGUMENT FOR THIS DESIGN, not the pretty URL.
// The tokenised route's failure mode is "the wall is dead until somebody finds
// the key"; this one's is "the wall asks for a password somebody on site
// knows". A cheap TV browser dropping its cookies after a power cut is a
// WHEN, not an IF — the requirements doc says smart-TV browsers commonly
// forget state — so the recoverable failure mode is worth more than the
// unguessable one.
//
// PURE MODULE — no env reads, no next/headers, no cookies(). Every secret is
// passed in. That is what makes the rule that decides who can see the
// facility's schedule provable in a unit test instead of something you have to
// trust.

import { createHmac } from "node:crypto";

/**
 * Minimum length for `DISPLAY_PASSWORD`.
 *
 * 🔴 A COMPROMISE, AND BOTH SIDES OF IT ARE REAL. Every extra character is
 * another press on a television remote's on-screen keyboard, so this cannot be
 * a 24-character token like `DISPLAY_TOKEN`. But a short shared password on a
 * public route is brute-forceable, which is why the unlock action is rate
 * limited and — unlike the magic-link limiter — **fails CLOSED**. See the note
 * on that in the unlock action: an Upstash outage cannot blank an already
 * unlocked TV, because a TV that is already unlocked never reaches the limiter.
 *
 * 8 with rate limiting is defensible. Fewer is not. A short PASSPHRASE
 * ("green cage tuesday") is easier to type on a remote than 8 random
 * characters and is far stronger — recommend that when setting it.
 */
export const DISPLAY_PASSWORD_MIN_LENGTH = 8;

/** The cookie the TV carries once it has been unlocked. */
export const DISPLAY_COOKIE_NAME = "pfa_display_access";

/** One year. See the header: this must outlive power cuts, not expire nightly. */
export const DISPLAY_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * Bumping this invalidates every issued cookie at once, without rotating the
 * signing secret. The escape hatch if a TV is ever lost or a password walks.
 */
const COOKIE_PAYLOAD = "display-access-v1";

/**
 * Constant-time string comparison.
 *
 * Duplicated from token.ts rather than shared, deliberately: token.ts is a
 * ZERO-DEPENDENCY module by design (its header says so) and importing this
 * file — which pulls in `node:crypto` — would take that away from it. Ten
 * lines is a cheaper price than coupling the two gates together.
 *
 * ⚠️ Leaks LENGTH, which is fine and deliberate: it compares only after the
 * length check, and an attacker who can measure the length of a shared display
 * password over a network round trip has already spent more effort than the
 * facility schedule is worth.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Is the display password gate CONFIGURED at all?
 *
 * 🔴 FAILS CLOSED. An absent or too-short `DISPLAY_PASSWORD` means the `/video`
 * route is DORMANT and 404s — never "no password set, so let everyone in".
 * Same posture as `isDisplayTokenValid`, and the same reason: the dangerous
 * misconfiguration is not a weak password, it is an EMPTY one that makes the
 * route answer 200 to the open internet while looking configured.
 */
export function isDisplayPasswordConfigured(configured: string | undefined): boolean {
  return (
    typeof configured === "string" && configured.length >= DISPLAY_PASSWORD_MIN_LENGTH
  );
}

/**
 * Does the password someone typed match the configured one?
 *
 * Returns false when the gate is not configured, so an unconfigured deployment
 * cannot be unlocked by submitting an empty box.
 */
export function isDisplayPasswordValid(
  supplied: string | undefined,
  configured: string | undefined,
): boolean {
  if (!isDisplayPasswordConfigured(configured)) return false;
  if (typeof supplied !== "string") return false;
  return constantTimeEquals(supplied.trim(), configured as string);
}

/**
 * The value written into the cookie once a password check has passed.
 *
 * 🔴 IT IS AN HMAC, NOT THE PASSWORD. Storing the password itself would work —
 * the cookie is httpOnly — but it would mean the secret sits in plaintext in
 * the cookie jar of a shared television, readable by anyone with physical
 * access to the TV's browser settings. An HMAC is not reversible, so what a
 * curious person finds on the TV cannot be typed into a laptop somewhere else.
 *
 * 🔴 SIGNED WITH `DISPLAY_TOKEN`, NOT WITH THE PASSWORD. The password is short
 * by necessity (see DISPLAY_PASSWORD_MIN_LENGTH); using it as an HMAC key
 * would make the cookie only as hard to forge as the password is to guess.
 * `DISPLAY_TOKEN` is already required to be 24+ characters and already exists
 * for the tokenised route, so it is the natural key and costs no new
 * configuration concept.
 */
export function displayCookieValue(signingSecret: string): string {
  return createHmac("sha256", signingSecret).update(COOKIE_PAYLOAD).digest("hex");
}

/**
 * Is this cookie one we issued?
 *
 * Fails closed on a missing/short secret, exactly like the token check —
 * otherwise removing `DISPLAY_TOKEN` from the environment would silently turn
 * a signed cookie into "any value is fine".
 */
export function isDisplayCookieValid(
  supplied: string | undefined,
  signingSecret: string | undefined,
): boolean {
  if (typeof signingSecret !== "string" || signingSecret.length < 24) return false;
  if (typeof supplied !== "string") return false;
  return constantTimeEquals(supplied, displayCookieValue(signingSecret));
}
