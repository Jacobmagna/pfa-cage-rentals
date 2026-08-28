// The lock on the TV display page.
//
// WHY A TOKEN AND NOT A LOGIN — the reasoning is in the project's
// REQUIREMENTS-AND-DECISIONS.md and it is worth not re-litigating: a session
// EXPIRES. If it dies at 2 AM the facility wall shows a login screen all
// morning and nobody notices until someone complains the schedule is gone —
// which is the precise "nobody will walk over and fix it" failure the whole
// feature exists to prevent. This repo has already been bitten by silent
// session death (maintenance discipline rule 22: a session was minted with
// too little headroom, Auth.js deleted it with no error and no log line, and
// the page simply bounced).
//
// 🔴 THE TOKEN IS THE SECOND LAYER, NOT THE ONLY ONE. It is only acceptable
// because the display's data layer never SELECTs `note`, `reason` or
// `coachEmail` (see src/lib/server/display-schedule.ts). If the URL leaks,
// what leaks is cages, times and coach names — which is what is already
// visible on a screen in a room the public walks through. Weaken either layer
// and the argument for the other one collapses.
//
// PURE MODULE — no env reads, no next/navigation. The page passes both values
// in. That is what makes the fail-closed behaviour provable in a unit test
// rather than something you have to trust.

/**
 * Refuse to treat anything shorter than this as a configured token.
 *
 * 🔴 THIS IS A GUARD AGAINST THE OPERATOR, NOT THE ATTACKER. The dangerous
 * mistake is not a short random token, it is `DISPLAY_TOKEN=""` or
 * `DISPLAY_TOKEN=changeme` in a dashboard somewhere — a value that LOOKS set,
 * makes the route answer 200, and is guessable. Refusing to run below a real
 * length turns that class of misconfiguration into a 404 instead of a
 * silently public schedule.
 */
export const DISPLAY_TOKEN_MIN_LENGTH = 24;

/**
 * Constant-time string comparison.
 *
 * Hand-rolled rather than `crypto.timingSafeEqual` so this module stays pure
 * and unit-testable with no node runtime dependency. It compares every
 * character of equal-length inputs and accumulates the difference, so the
 * running time does not depend on WHERE the first mismatch is.
 *
 * ⚠️ It does leak LENGTH, and that is fine and deliberate: the length of a
 * random token is not a secret, and the alternative (hashing both sides to a
 * fixed width) buys nothing against an attacker who cannot make enough
 * requests to time a network round trip anyway.
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
 * Is this request allowed to see the display?
 *
 * 🔴 FAILS CLOSED IN EVERY DIRECTION, AND THE MOST IMPORTANT ONE IS THE
 * SECOND: an ABSENT or too-short `configured` token means the capability is
 * DORMANT and the route is shut — never "no token set, so let everyone in".
 * That mirrors how the SMS and Data-Safe capabilities are wired in
 * src/lib/env.ts: optional env, parsed separately, inert until deliberately
 * switched on. It also means a preview deployment or a fresh local checkout
 * with no token serves a 404 rather than a public copy of the schedule.
 */
export function isDisplayTokenValid(
  supplied: string | undefined,
  configured: string | undefined,
): boolean {
  if (typeof configured !== "string") return false;
  if (configured.length < DISPLAY_TOKEN_MIN_LENGTH) return false;
  if (typeof supplied !== "string") return false;
  return constantTimeEquals(supplied, configured);
}
