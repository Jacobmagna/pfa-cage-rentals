import type { Metadata } from "next";
import { PublicShell } from "../_components/public-shell";

export const metadata: Metadata = {
  title: "Terms of Service — PFA Cage Rentals",
  description: "The rules for using PFA Cage Rentals.",
};

const EFFECTIVE_DATE = "May 24, 2026";

export default function TermsPage() {
  return (
    <PublicShell>
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">Legal</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Terms of Service</h1>
        <p className="mt-1 text-sm text-fg-subtle">Effective {EFFECTIVE_DATE}.</p>

        <Section title="Who can use this site">
          <p>
            PFA Cage Rentals is an internal tool for coaches authorized by PFA
            Sports to rent and log time in PFA&apos;s cages, bullpens, and
            weight-room facilities. By signing in, you confirm you have that
            authorization. PFA Sports may revoke your access at any time.
          </p>
        </Section>

        <Section title="What you can do">
          <p>You can:</p>
          <ul>
            <li>Log lessons against PFA facility resources.</li>
            <li>View and edit your own session history.</li>
            <li>See your billing total for each period.</li>
          </ul>
        </Section>

        <Section title="What you can't do">
          <ul>
            <li>
              Sign in as anyone other than yourself, or share your sign-in
              link with another person.
            </li>
            <li>
              Log sessions on behalf of another coach without explicit
              authorization from PFA Sports.
            </li>
            <li>
              Attempt to bypass rate limits, scrape session data in bulk, or
              probe the site for security vulnerabilities without prior
              written permission.
            </li>
            <li>
              Use the site for any purpose other than tracking PFA facility
              rentals.
            </li>
          </ul>
        </Section>

        <Section title="Billing">
          <p>
            Session totals shown in the app are PFA Sports&apos; internal
            tally. Actual invoicing and payment happens directly between you
            and PFA Sports outside this site. If you believe a session was
            logged incorrectly, contact{" "}
            <a className="text-gold hover:text-gold-hover" href="mailto:mdm@pfasports.com">
              mdm@pfasports.com
            </a>{" "}
            — every change to a session row is audit-logged and reviewable.
          </p>
        </Section>

        <Section title="Service availability">
          <p>
            We aim for high uptime but the site is provided as-is. Scheduled
            maintenance, hosting outages, or third-party service interruptions
            can cause temporary downtime. If the site is unavailable when you
            need to log a lesson, record it offline and enter it once the site
            is back up.
          </p>
        </Section>

        <Section title="Limitation of liability">
          <p>
            PFA Sports is not liable for indirect, incidental, or consequential
            damages arising from use of this site — including lost time, lost
            data, or billing disputes. Direct damages, if any, are limited to
            the amount of fees you have paid PFA Sports for facility rentals
            in the calendar month in which the issue arose.
          </p>
        </Section>

        <Section title="Termination">
          <p>
            PFA Sports may suspend or terminate your access if you violate
            these terms, misuse the site, or are no longer authorized to use
            PFA facilities. You can request deletion of your account at any
            time per the procedure in our{" "}
            <a className="text-gold hover:text-gold-hover" href="/privacy">
              Privacy Policy
            </a>
            .
          </p>
        </Section>

        <Section title="Governing law">
          <p>
            These terms are governed by the laws of the United States and the
            state in which PFA Sports is registered. Any dispute that
            can&apos;t be resolved informally will be brought in the courts of
            that state.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            We may update these terms; the effective date above will move
            forward when we do. Material changes will be announced via email
            to active accounts. Continued use after a change means you accept
            the updated terms.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about these terms?{" "}
            <a className="text-gold hover:text-gold-hover" href="mailto:mdm@pfasports.com">
              mdm@pfasports.com
            </a>
            .
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
