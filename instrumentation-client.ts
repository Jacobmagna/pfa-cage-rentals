/**
 * Client-side Sentry init (Next.js 15+ instrumentation-client.ts hook).
 *
 * Runs once per page session in the browser.
 */
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
  tracesSampleRate: 0.1,
  // Replays are a paid feature — disable.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  // PII guard — see instrumentation.ts notes.
  sendDefaultPii: false,
  // No-op when DSN missing (local dev without Sentry credentials).
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
});

// Required by Next.js — capture client-side router transitions for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
