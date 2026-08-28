// Magic-link rate limiting via Upstash Redis. Two windows so a
// single bad actor can't burn through someone else's per-email
// quota by spraying random addresses:
//
//   - per-email:  5 requests per hour. Stops an attacker (or a
//     confused coach) from triggering 50 emails to one address.
//     This is the real per-target abuse protection.
//   - per-ip:   100 requests per hour. Generous on purpose: whole
//     coaching staffs onboard at once from a single office Wi-Fi,
//     sharing ONE public IP, so a tight per-IP cap would lock out
//     everyone past the limit. The per-email window above still
//     stops scripted spraying against any single address, so the
//     IP window only needs to be a coarse flood backstop on Resend.
//
// Both limits use Upstash's sliding-window algorithm — more
// accurate than fixed buckets at the boundary between windows.
//
// Lazy init: Redis.fromEnv() reads process.env at call time, so
// importing this module is safe even when UPSTASH_* env vars are
// absent (e.g. CI builds). The first actual rate-limit check is
// where the failure surfaces, and at that point the env validator
// in src/lib/env.ts will already have flagged the missing vars to
// /api/health.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import * as Sentry from "@sentry/nextjs";

let cachedRedis: Redis | undefined;
let cachedEmailLimit: Ratelimit | undefined;
let cachedIpLimit: Ratelimit | undefined;

function getEmailLimit(): Ratelimit {
  if (!cachedEmailLimit) {
    cachedRedis ??= Redis.fromEnv();
    cachedEmailLimit = new Ratelimit({
      redis: cachedRedis,
      limiter: Ratelimit.slidingWindow(5, "1 h"),
      prefix: "rl:magic-link:email",
      analytics: false,
    });
  }
  return cachedEmailLimit;
}

function getIpLimit(): Ratelimit {
  if (!cachedIpLimit) {
    cachedRedis ??= Redis.fromEnv();
    cachedIpLimit = new Ratelimit({
      redis: cachedRedis,
      limiter: Ratelimit.slidingWindow(100, "1 h"),
      prefix: "rl:magic-link:ip",
      analytics: false,
    });
  }
  return cachedIpLimit;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "email-limit" | "ip-limit"; resetAt: number };

/**
 * Checks both the email and IP rate limits in parallel. Returns
 * `allowed: true` only when both pass — the first failing limit
 * is reported in `reason`, with `resetAt` (epoch ms) so the UI
 * can render a useful retry-after message later.
 *
 * Email is lowercased so `Foo@bar.com` and `foo@bar.com` share
 * the same bucket. IP can be anything (forwarded chain, "unknown"
 * for local dev) — buckets are just opaque strings to Upstash.
 */
export async function checkMagicLinkRateLimit(
  email: string,
  ip: string,
): Promise<RateLimitDecision> {
  const emailKey = email.trim().toLowerCase();

  // FAIL OPEN: if Upstash is unreachable / over-quota, `.limit()` throws.
  // A rate limiter that bricks login when its backing store hiccups is
  // strictly worse than no limiter — especially during a synchronized
  // sign-in surge, where an Upstash blip would otherwise block EVERY
  // coach. So on ANY error we treat the request as not-rate-limited
  // (return allowed) and report to Sentry for visibility. Degrading the
  // per-email guard to open during an outage is the correct tradeoff on
  // a login surface; the normal (Upstash-up) path is unchanged.
  try {
    const [emailResult, ipResult] = await Promise.all([
      getEmailLimit().limit(emailKey),
      getIpLimit().limit(ip),
    ]);

    if (!emailResult.success) {
      return { allowed: false, reason: "email-limit", resetAt: emailResult.reset };
    }
    if (!ipResult.success) {
      return { allowed: false, reason: "ip-limit", resetAt: ipResult.reset };
    }
    return { allowed: true };
  } catch (err) {
    Sentry.captureException(err);
    return { allowed: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPLAY UNLOCK (/video) — added 2026-08-27
//
// 🔴 THIS ONE FAILS CLOSED, AND IT IS THE ONLY LIMITER HERE THAT DOES. Read
// the long note above on the magic-link limiter: it fails OPEN because a
// rate limiter that bricks sign-in when Upstash hiccups is worse than no
// limiter — an outage during a staff onboarding surge would lock out every
// coach at once.
//
// The display gate has the OPPOSITE risk profile, for one specific reason:
// a television that is already unlocked carries a year-long cookie and NEVER
// REACHES THIS CODE. Only a fresh unlock does. So failing closed cannot blank
// the wall — the worst case is that somebody standing at the TV during an
// Upstash outage cannot log a NEW screen in, which is a minor inconvenience,
// while failing open would hand an attacker unlimited guesses at a password
// that is deliberately short enough to type on a remote
// (DISPLAY_PASSWORD_MIN_LENGTH is 8, and that is a compromise with a TV
// keyboard, not a security opinion).
//
// 10 per hour per IP: generous for a human who fat-fingered it on an on-screen
// keyboard three times, useless for a script.
let cachedDisplayLimit: Ratelimit | undefined;

function getDisplayUnlockLimit(): Ratelimit {
  if (!cachedDisplayLimit) {
    cachedRedis ??= Redis.fromEnv();
    cachedDisplayLimit = new Ratelimit({
      redis: cachedRedis,
      limiter: Ratelimit.slidingWindow(10, "1 h"),
      prefix: "rl:display-unlock:ip",
      analytics: false,
    });
  }
  return cachedDisplayLimit;
}

/**
 * Guards the /video password box. `true` = this attempt may proceed.
 *
 * 🔴 FAILS CLOSED on any error (see the note above). An unconfigured Upstash
 * in local dev therefore refuses the unlock — which is correct and is why the
 * QA harness drives the cookie path directly rather than the password box.
 */
export async function checkDisplayUnlockRateLimit(ip: string): Promise<boolean> {
  try {
    const res = await getDisplayUnlockLimit().limit(ip);
    return res.success;
  } catch (err) {
    Sentry.captureException(err, { tags: { ratelimit: "display_unlock_failed_closed" } });
    return false;
  }
}
