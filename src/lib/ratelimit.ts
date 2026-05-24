// Magic-link rate limiting via Upstash Redis. Two windows so a
// single bad actor can't burn through someone else's per-email
// quota by spraying random addresses:
//
//   - per-email:  5 requests per hour. Stops an attacker (or a
//     confused coach) from triggering 50 emails to one address.
//   - per-ip:    10 requests per hour. Stops the "loop a script
//     against random emails" scenario before it floods Resend.
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
      limiter: Ratelimit.slidingWindow(10, "1 h"),
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
}
