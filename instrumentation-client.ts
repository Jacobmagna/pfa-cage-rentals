/**
 * Client-side Sentry init (Next.js 15+ instrumentation-client.ts hook).
 *
 * Runs once per page session in the browser.
 */
import * as Sentry from "@sentry/nextjs";
import { scrubPii } from "@/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Release tag matches instrumentation.ts (server). Sentry groups
  // client + server errors by release for regression detection.
  release:
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "development",
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
  tracesSampleRate: 0.1,
  // Replays are a paid feature — disable.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  // PII guard — see instrumentation.ts notes.
  sendDefaultPii: false,
  // Defense-in-depth: redact likely PII from the event before send. Never
  // throws / never drops events. See sentry-scrub.
  beforeSend: scrubPii,
  // Report ONLY from deployed builds — mirrors instrumentation.ts (server);
  // see the long note there for why localhost is silenced and why the gate is
  // NODE_ENV rather than a Vercel system env var. Next.js inlines NODE_ENV
  // into the client bundle at build time, so this is "production" for both
  // prod and preview deploys and "development" under `next dev`.
  enabled:
    !!process.env.NEXT_PUBLIC_SENTRY_DSN &&
    process.env.NODE_ENV === "production",
});

// Required by Next.js — capture client-side router transitions for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
