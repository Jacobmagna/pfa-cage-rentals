/**
 * Next.js instrumentation hook (server + edge runtimes).
 *
 * Sentry init runs once per worker on server start. Client-side init lives in
 * `instrumentation-client.ts` (Next.js 15+ pattern).
 *
 * Docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
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
