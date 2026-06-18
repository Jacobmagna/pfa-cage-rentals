import type { Metadata } from "next";
import { PublicShell } from "../_components/public-shell";

export const metadata: Metadata = {
  title: "SMS Opt-In Evidence — PFA Engine",
  description:
    "A2P 10DLC opt-in evidence for the PFA Engine coach SMS reminder program.",
  robots: { index: false, follow: false },
};

const REMINDER_SAMPLE =
  "PFA Engine: Hi Coach — you haven't logged your work for yesterday yet. Log it here: https://pfaengine.com/coach/hour-log Reply STOP to opt out, HELP for help.";

const STOP_REPLY =
  "You're unsubscribed from PFA Engine reminders and won't get more texts. Reply START to resubscribe.";

const HELP_REPLY =
  "PFA Engine reminders: we text when you have unlogged work. Msg & data rates may apply. Reply STOP to unsubscribe. Help: contact PFA Sports Academy, mdm@pfasports.com.";

export default function SmsOptInEvidencePage() {
  return (
    <PublicShell>
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">Compliance</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          SMS Opt-In Evidence — PFA Engine Coach Reminders
        </h1>

        <Section title="Who this is for & what the program is">
          <p>
            PFA Engine (operated by Magna Software LLC) is a private operations
            platform used <strong>only</strong> by PFA Sports Academy&apos;s own
            coaching staff. It is a <strong>closed group</strong> of the
            academy&apos;s employed coaches — it is not available to, or used by,
            the general public.
          </p>
          <p>
            The SMS program serves a single purpose: a daily reminder for coaches
            to log their coaching hours. Message frequency is about{" "}
            <strong>one message per day</strong>, and only on days a coach has
            unlogged scheduled work. <strong>Message and data rates may apply.</strong>
          </p>
          <p>
            For full program terms see the{" "}
            <a
              className="text-gold-strong underline underline-offset-2 hover:text-fg-muted"
              href="/sms-terms"
            >
              SMS Terms
            </a>{" "}
            and our{" "}
            <a
              className="text-gold-strong underline underline-offset-2 hover:text-fg-muted"
              href="/privacy"
            >
              Privacy Policy
            </a>
            , which states that mobile numbers are not shared with third parties.
          </p>
        </Section>

        <Section title="How coaches opt in (the consent moment)">
          <p>
            After a coach accepts a login invitation and signs in, they enter
            their own mobile number in their account profile and check an opt-in
            checkbox — <strong>unchecked by default</strong> — actively
            consenting to the reminder texts.
          </p>
          <p>
            Because this consent screen sits behind a login, the screenshots
            below show the opt-in exactly as a coach sees it.
          </p>

          <figure className="mt-4">
            <img
              src="/sms-evidence/consent-card.png"
              alt="PFA Engine coach SMS opt-in: mobile number field and unchecked consent checkbox with full disclosure"
              className="w-full max-w-xl rounded-lg border border-line shadow-[var(--shadow-sm)]"
            />
            <figcaption className="mt-2 text-xs text-fg-subtle">
              The opt-in as first shown — empty phone field, consent checkbox
              unchecked.
            </figcaption>
          </figure>

          <figure className="mt-6">
            <img
              src="/sms-evidence/consent-card-filled.png"
              alt="PFA Engine coach SMS opt-in: phone number entered and consent checkbox checked"
              className="w-full max-w-xl rounded-lg border border-line shadow-[var(--shadow-sm)]"
            />
            <figcaption className="mt-2 text-xs text-fg-subtle">
              After the coach enters their number and actively checks the consent
              box.
            </figcaption>
          </figure>
        </Section>

        <Section title="The exact consent disclosure">
          <p>This is the verbatim text a coach agrees to when they opt in:</p>
          <blockquote className="mt-2 rounded-lg border border-line bg-surface-2 p-4 text-fg">
            I agree to receive account-notification text messages from PFA Engine
            (a daily reminder to log my coaching hours). Message frequency is
            about 1 message per day on days with unlogged hours. Message and data
            rates may apply. Reply STOP to opt out, HELP for help.
          </blockquote>
        </Section>

        <Section title="Sample message & auto-replies">
          <p>
            <strong>Reminder (sample):</strong>
          </p>
          <pre className="rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg whitespace-pre-wrap break-words">
            {REMINDER_SAMPLE}
          </pre>
          <p>
            <strong>On STOP (reply):</strong>
          </p>
          <pre className="rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg whitespace-pre-wrap break-words">
            {STOP_REPLY}
          </pre>
          <p>
            <strong>On HELP (reply):</strong>
          </p>
          <pre className="rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs text-fg whitespace-pre-wrap break-words">
            {HELP_REPLY}
          </pre>
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
