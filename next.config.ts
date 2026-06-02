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

  // Without this, Next allows server actions only from the request's own
  // host. Documenting the intended production hosts explicitly makes the
  // security boundary visible in source and protects against a future
  // proxy/CDN config silently expanding the surface.
  //
  // Includes the current Vercel deploy URL at build time so preview
  // deploys can still exercise server actions (each preview gets a unique
  // pfa-cage-rentals-<hash>-jacobmagnas-projects.vercel.app — we read
  // VERCEL_URL to include the per-build one).
  experimental: {
    serverActions: {
      allowedOrigins: [
        "www.pfaengine.com",
        "pfaengine.com",
        "www.pfacagerentals.com",
        "pfacagerentals.com",
        "pfa-cage-rentals.vercel.app",
        ...(process.env.VERCEL_URL ? [process.env.VERCEL_URL] : []),
      ],
    },
  },

  async headers() {
    // Security headers applied to every response.
    // CSP iterated as integrations are added — keep tight by default.
    //
    // 'unsafe-eval' is allowed ONLY in development — React dev-mode
    // uses eval() to reconstruct call stacks for the error overlay
    // (and Next.js Turbopack HMR needs it). Production never needs
    // it (React's prod build never calls eval), and we don't want
    // to weaken the prod policy.
    const isDev = process.env.NODE_ENV !== "production";
    const scriptSrc = isDev
      ? "'self' 'unsafe-inline' 'unsafe-eval' https://vercel.live"
      : "'self' 'unsafe-inline' https://vercel.live";
    const csp = [
      "default-src 'self'",
      `script-src ${scriptSrc}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      // connect-src includes Sentry's ingest endpoint (uses *.sentry.io wildcard)
      // and Resend's API (server-side, but client may also call via fetch).
      "connect-src 'self' https://api.resend.com https://*.sentry.io https://*.ingest.us.sentry.io",
      // object-src + frame-src explicit even though default-src 'self' already
      // restricts them — Mozilla Observatory looks for these as named
      // directives, not the default-src fallback. We never embed <object>,
      // <embed>, or <iframe>, so 'none' is correct.
      "object-src 'none'",
      "frame-src 'none'",
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
  // Tunnel client errors through a Next.js route to bypass ad-blockers.
  tunnelRoute: "/monitoring",

  widenClientFileUpload: true,
});
