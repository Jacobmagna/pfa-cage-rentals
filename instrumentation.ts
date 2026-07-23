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
import { scrubPii } from "@/lib/sentry-scrub";

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

  // Report ONLY from deployed builds. A DSN alone used to be the gate, so a
  // local `next dev` run (which reads the same DSN from .env.local) shipped
  // its errors into the SAME Sentry project as production — a QA harness on
  // a laptop could page us with a "high priority issue" about synthetic seed
  // rows in the dev database (2026-07-23, HourLogNotFoundError from
  // scripts/qa/verify-held-details.ts). False alarms train us to ignore the
  // alerts we actually depend on, so localhost is now silent.
  //
  // Gate on NODE_ENV, NOT VERCEL/VERCEL_ENV: NODE_ENV is always "production"
  // in a Vercel build (prod AND preview) and needs no dashboard toggle, so it
  // cannot silently disable real monitoring the way a missing system env var
  // could. Same predicate tracesSampleRate already uses below. Trade-off: a
  // local production build (`next build && next start`) still reports — our
  // QA harnesses run `next dev`, so the noise source is covered.
  const reportingEnabled =
    !!process.env.NEXT_PUBLIC_SENTRY_DSN &&
    process.env.NODE_ENV === "production";

  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      release,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
      // Send default PII (request data) only — no body capture (could include
      // billing data, coach emails). Tune later if we need more context.
      sendDefaultPii: false,
      // Defense-in-depth: redact likely PII (emails/phones/birthdays) from the
      // event before send. Never throws / never drops events. See sentry-scrub.
      beforeSend: scrubPii,
      enabled: reportingEnabled,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      release,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
      sendDefaultPii: false,
      // See node init above — same PII scrubber for the edge runtime.
      beforeSend: scrubPii,
      enabled: reportingEnabled,
    });
  }
}

// Forward server-action errors and uncaught request errors to Sentry.
// Without this, Next.js swallows them and we never see them.
export const onRequestError = Sentry.captureRequestError;
