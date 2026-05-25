import type { Metadata } from "next";
import { PublicShell } from "../_components/public-shell";

export const metadata: Metadata = {
  title: "Privacy Policy — PFA Cage Rentals",
  description: "How PFA Cage Rentals handles your data.",
};

const EFFECTIVE_DATE = "May 24, 2026";

export default function PrivacyPage() {
  return (
    <PublicShell>
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">Legal</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-1 text-sm text-fg-subtle">Effective {EFFECTIVE_DATE}.</p>

        <Section title="Who we are">
          <p>
            PFA Cage Rentals is an internal billing tool operated by PFA Sports
            for tracking cage, bullpen, and weight-room rentals at the
            facility. The site lives at{" "}
            <code className="text-fg">pfacagerentals.com</code>. Contact for
            privacy questions:{" "}
            <a className="text-gold underline underline-offset-2 hover:text-gold-hover" href="mailto:mdm@pfasports.com">
              mdm@pfasports.com
            </a>
            .
          </p>
        </Section>

        <Section title="What we collect">
          <ul>
            <li>
              <strong>Account info:</strong> your email address and display
              name (from Google sign-in, or what you type when requesting a
              magic-link login).
            </li>
            <li>
              <strong>Session records:</strong> the dates, times, and resources
              (cage / bullpen / weight room) you log lessons against.
            </li>
            <li>
              <strong>Audit log:</strong> a record of who created, edited, or
              deleted each session row — for billing-dispute investigation.
            </li>
            <li>
              <strong>Technical data:</strong> your IP address (used briefly to
              rate-limit sign-in attempts) and standard server logs (request
              path, response code, timestamp).
            </li>
          </ul>
          <p>
            We do <strong>not</strong> collect: student names, payment card
            data, health information, location data, advertising IDs, or any
            third-party analytics.
          </p>
        </Section>

        <Section title="How we use it">
          <ul>
            <li>Authenticating you (only signed-in coaches can log sessions).</li>
            <li>
              Generating monthly billing reports for PFA Sports based on your
              logged sessions.
            </li>
            <li>
              Showing you your own session history and totals.
            </li>
            <li>
              Investigating billing disputes via the audit log.
            </li>
          </ul>
          <p>
            We do not use your data to send marketing, sell ads, or train AI
            models.
          </p>
        </Section>

        <Section title="Service providers we share with">
          <p>
            We use a handful of infrastructure vendors to run the site. Each
            sees only the data it needs to do its job:
          </p>
          <ul>
            <li>
              <strong>Google</strong> (OAuth sign-in): receives the email
              address you choose to sign in with.
            </li>
            <li>
              <strong>Resend</strong> (transactional email): delivers magic-link
              sign-in emails.
            </li>
            <li>
              <strong>Neon</strong> (Postgres database): stores all account +
              session records.
            </li>
            <li>
              <strong>Vercel</strong> (hosting): serves the site.
            </li>
            <li>
              <strong>Sentry</strong> (error tracking): captures crashes; may
              incidentally include user IDs in stack traces.
            </li>
            <li>
              <strong>Upstash</strong> (rate limiting): stores email + IP rate
              counters for ~1 hour windows.
            </li>
          </ul>
          <p>
            We do not sell your data to anyone and do not share it with third
            parties for their own marketing.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            Session and billing records are retained for{" "}
            <strong>seven years</strong> after the session date, matching the
            IRS recommendation for retaining business tax records. Audit log
            entries are retained for the same window.
          </p>
          <p>
            Sign-in sessions (the cookie that keeps you logged in) expire after
            30 days. Magic-link tokens expire after 24 hours.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            You can:
          </p>
          <ul>
            <li>
              <strong>Access</strong> the data we hold about you (your account
              info + your full session history are visible in your dashboard).
            </li>
            <li>
              <strong>Correct</strong> your displayed name directly from your
              dashboard.
            </li>
            <li>
              <strong>Request deletion</strong> of your account. Email{" "}
              <a className="text-gold underline underline-offset-2 hover:text-gold-hover" href="mailto:mdm@pfasports.com">
                mdm@pfasports.com
              </a>
              . We&apos;ll anonymize your account and remove your displayed
              name from session rows within 14 days. Billing-relevant amounts
              and timestamps stay in our records under the retention policy
              above, but are no longer linked to your identity.
            </li>
          </ul>
        </Section>

        <Section title="Cookies">
          <p>
            We set one cookie: an Auth.js session cookie that keeps you signed
            in. We do not use analytics cookies, advertising cookies, or any
            third-party tracking pixels.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            We&apos;ll post any updates to this policy on this page with a new
            effective date. Material changes will also be announced via email
            to active accounts.
          </p>
        </Section>
      </div>
    </PublicShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold tracking-tight text-fg">{title}</h2>
      <div className="mt-2 space-y-3 text-sm text-fg-muted leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1.5 [&_strong]:text-fg [&_strong]:font-medium">
        {children}
      </div>
    </section>
  );
}
