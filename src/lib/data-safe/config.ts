// Data-Safe Snapshot config — reads the OPTIONAL `DATA_SAFE_*` env vars
// LAZILY at call time (mirrors the `Redis.fromEnv()` pattern in
// src/lib/ratelimit.ts), never at module load. With the vars unset this
// returns `{ enabled: false, k: 5 }` and never throws — so `npm run build`
// and the test suite pass without any of the data-safe vars present.
//
// The whole capability is dormant until go-live: nothing on the live path
// imports this, and the cron route no-ops when `enabled` is false.

export type DataSafeConfig = {
  enabled: boolean;
  databaseUrl?: string;
  clientId?: string;
  vertical?: string;
  salt?: string;
  k: number;
};

const K_FALLBACK = 5;

/**
 * Reads the optional DATA_SAFE_* env once, at call time. No throwing on
 * missing values — callers (snapshot orchestrator / cron) decide what to
 * require for a real push vs a dry-run.
 *
 * `enabled` is strictly `DATA_SAFE_ENABLED === "true"`. `k` defaults to 5
 * and ignores a malformed/<1 value.
 */
export function getDataSafeConfig(): DataSafeConfig {
  const rawK = process.env.DATA_SAFE_K;
  const parsedK = rawK ? Number.parseInt(rawK, 10) : NaN;
  const k = Number.isInteger(parsedK) && parsedK >= 1 ? parsedK : K_FALLBACK;

  return {
    enabled: process.env.DATA_SAFE_ENABLED === "true",
    databaseUrl: process.env.DATA_SAFE_DATABASE_URL || undefined,
    clientId: process.env.DATA_SAFE_CLIENT_ID || undefined,
    vertical: process.env.DATA_SAFE_VERTICAL || undefined,
    salt: process.env.DATA_SAFE_SALT || undefined,
    k,
  };
}
