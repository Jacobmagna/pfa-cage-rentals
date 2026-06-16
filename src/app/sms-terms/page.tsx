import type { Metadata } from "next";
import { PublicShell } from "../_components/public-shell";

export const metadata: Metadata = {
  title: "SMS Terms — PFA Engine",
  description: "Terms for the PFA Engine coach SMS reminder program.",
};

export default function SmsTermsPage() {
  return (
    <PublicShell>
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">Legal</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          SMS Messaging Terms — PFA Engine Coach Reminders
        </h1>

        <Section title="Overview">
          <p>
            PFA Engine (operated by Magna Software LLC) offers an optional SMS
            reminder program for coaches of PFA Sports Academy.
          </p>
          <ul>
            <li>
              <strong>Program:</strong> If you opt in, PFA Engine sends reminder
              texts when you have unlogged work, with a link to the work-log
              page.
            </li>
            <li>
              <strong>Message frequency:</strong> Varies — up to about one
              message per day, only when you have unlogged work.
            </li>
            <li>
              <strong>Cost:</strong>{" "}
              <strong>Message and data rates may apply.</strong>
            </li>
            <li>
              <strong>Opt in:</strong> Enter your mobile number and turn on SMS
              reminders in your PFA Engine account settings.
            </li>
            <li>
              <strong>Get help:</strong> Reply <strong>HELP</strong> to any
              message, or contact PFA Sports Academy at{" "}
              <a
                className="text-gold-strong underline underline-offset-2 hover:text-fg-muted"
                href="mailto:mdm@pfasports.com"
              >
                mdm@pfasports.com
              </a>
              .
            </li>
            <li>
              <strong>Opt out:</strong> Reply <strong>STOP</strong> to any
              message to unsubscribe at any time, or turn off SMS reminders in
              your settings.
            </li>
          </ul>
          <p>
            Your mobile number is used only for these reminders. It is never
            sold, shared with third parties, or used for marketing. Carriers are
            not liable for delayed or undelivered messages.
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
