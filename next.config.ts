import path from "node:path";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },

  // Forward Vercel's server-side git SHA into the client bundle so
  // instrumentation-client.ts can tag Sentry releases. Without this,
  // client errors land under release "development" even in prod.
  // Inlined at build time — no runtime cost.
  env: {
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  },

  async headers() {
    // Security headers applied to every response.
    // CSP iterated as integrations are added — keep tight by default.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://vercel.live",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      // connect-src includes Sentry's ingest endpoint (uses *.sentry.io wildcard)
      // and Resend's API (server-side, but client may also call via fetch).
      "connect-src 'self' https://api.resend.com https://*.sentry.io https://*.ingest.us.sentry.io",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://accounts.google.com",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

// Wrap with Sentry. Source-map upload requires SENTRY_AUTH_TOKEN, SENTRY_ORG,
// SENTRY_PROJECT at build time (set in Vercel). Without them, build proceeds
// without source-map upload (no error, just unsymbolicated stack traces).
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Suppress upload errors when env vars are missing (CI/local dev).
  silent: !process.env.CI,
  // Don't upload source maps in dev — only on Vercel builds.
  disableLogger: true,
  // Tunnel client errors through a Next.js route to bypass ad-blockers.
  tunnelRoute: "/monitoring",

  widenClientFileUpload: true,
});
