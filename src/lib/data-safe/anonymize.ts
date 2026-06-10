// PURE de-identification helpers for the Data-Safe Snapshot job. No DB,
// no Date.now() — deterministic given inputs, so the whole branch space
// is unit-testable without mocks (mirrors src/lib/billing.ts discipline).
//
// Two jobs:
//   1. anonId — turn a raw coach id into a stable, salted, one-way token
//      so the central store never sees a real id (and can't be reversed
//      without the per-client salt).
//   2. meetsK / dimsHash — k-anonymity gate + a deterministic hash of a
//      fact's `dims` so the exporter's idempotency key is stable.

import { createHash, createHmac } from "node:crypto";

/** Default k-anonymity threshold: suppress any group smaller than this. */
export const K_DEFAULT = 5;

/**
 * Stable, salted, one-way anonymized id for a raw entity id within a
 * namespace. = base64url(HMAC-SHA256(salt, `${namespace}:${rawId}`))
 * truncated to 16 chars.
 *
 * - Deterministic: same (salt, namespace, rawId) → same token.
 * - Salt-sensitive: a different salt → a different token (so two client
 *   deployments can't be cross-linked, and the token can't be reversed
 *   without the salt).
 * - Namespace-separated: the same rawId under "coach" vs another domain
 *   yields different tokens, so ids can't collide across entity types.
 */
export function anonId(salt: string, namespace: string, rawId: string): string {
  return createHmac("sha256", salt)
    .update(`${namespace}:${rawId}`)
    .digest("base64url")
    .slice(0, 16);
}

/** k-anonymity gate: a group of `count` is safe to emit iff count >= k. */
export function meetsK(count: number, k: number): boolean {
  return count >= k;
}

/**
 * Deterministic hash of a fact's `dims`, used by the exporter as part of
 * the idempotency key so re-runs dedupe regardless of object key order.
 * Canonical JSON = keys sorted; empty/absent dims → "" (so dims-less
 * facts share one stable bucket).
 *
 * Exported so both `computeAggregates` (Worker A) and `pushFacts`
 * (Worker B) hash dims the EXACT same way.
 */
export function dimsHash(
  dims: Record<string, string | number> | null | undefined,
): string {
  if (!dims || Object.keys(dims).length === 0) return "";
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.keys(dims)
        .sort()
        .map((key) => [key, dims[key]]),
    ),
  );
  return createHash("sha256").update(canonical).digest("hex");
}
