/**
 * Next.js instrumentation hook (server + edge runtimes).
 *
 * Sentry init runs once per worker on server start. Client-side init lives in
 * `instrumentation-client.ts` (Next.js 15+ pattern).
 *
 * Docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 */
import * as Sentry from "@sentry/nextjs";
import { validateRequiredEnv } from "@/lib/env";

export async function register() {
  // Boot-time env guard — logs loudly but never throws. An instrumentation-
  // time throw surfaces as MIDDLEWARE_INVOCATION_FAILED on every route
  // including /api/health, leaving uptime monitors blind. /api/health
  // degrades to 503 with a structured body listing missing vars, so
  // misconfiguration is visible without bricking boot. Pattern lifted
  // from doc-insured-backend after their 2026-05-02 incident.
  validateRequiredEnv();

  // Release tag = git SHA of the deployed commit. Vercel injects
  // VERCEL_GIT_COMMIT_SHA on every build; locally falls back to "development"
  // so dev errors don't claim to be from a production release. Sentry uses
  // this to group errors by deploy and power "regression introduced in
  // release X" alerts.
  const release = process.env.VERCEL_GIT_COMMIT_SHA ?? "development";

  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      release,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
      // Send default PII (request data) only — no body capture (could include
      // billing data, coach emails). Tune later if we need more context.
      sendDefaultPii: false,
      enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      release,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
      sendDefaultPii: false,
      enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
    });
  }
}

// Forward server-action errors and uncaught request errors to Sentry.
// Without this, Next.js swallows them and we never see them.
export const onRequestError = Sentry.captureRequestError;
