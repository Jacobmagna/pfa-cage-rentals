// Required-env validator. Production deploys MUST have every variable in
// the schema below set; missing or malformed values are surfaced via
// /api/health (503 with structured body) so Better Stack can distinguish
// "missing config" from "totally bricked."
//
// Why not throw at boot: an instrumentation-time throw bricks every route
// including /api/health, leaving the uptime monitor blind. (Pattern lifted
// from doc-insured-backend, which learned this the hard way — see comment
// in their src/instrumentation.ts referring to the 2026-05-02 incident.)
//
// Better shape: log loudly, surface in /api/health, let routes that need
// a specific var 503 individually if they're hit.
//
// Why a guard rather than a typed env object: most call sites use
// process.env.X directly, and refactoring all of them risks more bugs than
// it fixes. The guard pattern catches the typo class ("AUTH_RESEND_KEY = ''")
// at boot without forcing a codebase-wide migration.

import { z } from "zod";

// Required vars — getMissingRequiredEnv() reports any that are absent or
// malformed. Add a new entry whenever a slice introduces a new dependency
// on env.
//
// `min(1)` rejects empty strings ('""' is valid in env but useless).
// URL/format checks are deliberately loose — Vercel paste mistakes
// (`https//` typo, trailing newline) get caught downstream.
const REQUIRED_SCHEMA = z.object({
  // Postgres connection — every server request needs it
  DATABASE_URL: z.string().min(1),

  // Auth.js
  AUTH_SECRET: z.string().min(1),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  AUTH_RESEND_KEY: z.string().min(1),

  // Observability — degrades silently if missing (Sentry no-ops), but
  // production-grade requires it.
  NEXT_PUBLIC_SENTRY_DSN: z.string().url(),
});

// AUTH_URL is required in production (Auth.js builds OAuth callback URLs
// from it) but auto-derives from request host in dev. Split out so dev
// machines without AUTH_URL still report healthy.
const PRODUCTION_ONLY_SCHEMA = z.object({
  AUTH_URL: z.string().url(),
});

export type MissingEnv = {
  key: string;
  reason: string;
};

const isProduction = () => process.env.VERCEL_ENV === "production";

/**
 * Returns the list of required env vars that are missing or malformed.
 * Empty array = healthy.
 */
export function getMissingRequiredEnv(): MissingEnv[] {
  const result = REQUIRED_SCHEMA.safeParse(process.env);
  const issues: MissingEnv[] = result.success
    ? []
    : result.error.issues.map((issue) => ({
        key: issue.path.join("."),
        reason: issue.message,
      }));

  if (isProduction()) {
    const prodResult = PRODUCTION_ONLY_SCHEMA.safeParse(process.env);
    if (!prodResult.success) {
      issues.push(
        ...prodResult.error.issues.map((issue) => ({
          key: issue.path.join("."),
          reason: issue.message,
        })),
      );
    }
  }

  return issues;
}

/**
 * Logs loudly when required env is missing/malformed. NEVER throws —
 * an instrumentation-time throw bricks every route including /api/health.
 * Misconfiguration surfaces via /api/health 503 instead.
 *
 * Called from instrumentation.ts's register() hook.
 */
export function validateRequiredEnv(): void {
  const missing = getMissingRequiredEnv();
  if (missing.length === 0) return;

  console.error("======================================================");
  console.error(" REQUIRED ENV VARS MISSING OR MALFORMED");
  console.error("======================================================");
  for (const item of missing) {
    console.error(`  ${item.key}: ${item.reason}`);
  }
  console.error("------------------------------------------------------");
  console.error(" /api/health will respond 503 until resolved.");
  console.error("======================================================");
}
