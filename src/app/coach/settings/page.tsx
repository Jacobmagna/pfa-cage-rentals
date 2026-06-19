import Link from "next/link";
import { eq } from "drizzle-orm";
import { BookOpen, LogOut, Mail, Settings } from "lucide-react";
import { signOut } from "@/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { SmsReminderCard } from "../_components/sms-reminder-card";

// /coach/settings — DESIGN-2. The coach's self-service settings home.
// Reached via the gear entry-point in the header (owned by a parallel
// worker on app-shell.tsx). This is where ongoing SMS-reminder
// management lives: the SmsReminderCard here uses surface="settings" so
// it never collapses (setup form when unanswered → compact management
// card once answered), whereas the /coach home page shows that same card
// only as the one-time first-login setup prompt and then collapses it.
//
// Server component — inherits the coach AppShell via coach/layout.tsx, so
// it must NOT wrap itself in AppShell. Auth + the SMS-prefs read mirror
// the pattern in coach/page.tsx (coach-scoped to session.user.id). Also
// surfaces read-only account info, a Coach Guide link, and Sign out.

export default async function CoachSettings() {
  const session = await requireSession();

  const [smsRow] = await db
    .select({
      phone: users.phone,
      smsOptIn: users.smsOptIn,
      smsPromptAnsweredAt: users.smsPromptAnsweredAt,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  return (
    <div className="max-w-2xl mx-auto">
      <header className="mb-10">
        <div className="flex items-center gap-2 text-fg-muted">
          <Settings className="h-4 w-4" />
          <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
            Settings
          </p>
        </div>
        <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight">
          Settings
        </h1>
        <p className="mt-2 text-sm text-fg-muted">
          Manage your reminders and account.
        </p>
      </header>

      <SmsReminderCard
        surface="settings"
        initialPhone={smsRow?.phone ?? null}
        initialOptIn={smsRow?.smsOptIn ?? false}
        initialPromptAnswered={smsRow?.smsPromptAnsweredAt != null}
      />

      {/* Account (read-only) */}
      <section
        aria-labelledby="account-heading"
        className="mb-10 rounded-2xl border border-line bg-surface px-6 py-5 shadow-[var(--shadow-sm)]"
      >
        <div className="flex items-center gap-2 text-fg-muted">
          <Mail className="h-4 w-4" />
          <p
            id="account-heading"
            className="text-[11px] uppercase tracking-[0.14em] text-fg-muted"
          >
            Account
          </p>
        </div>

        <dl className="mt-4 space-y-4">
          <div>
            <dt className="text-xs uppercase tracking-wider text-fg-muted">
              Email
            </dt>
            <dd className="mt-1 text-sm font-medium text-fg break-words">
              {session.user.email ?? "—"}
            </dd>
            <p className="mt-1 text-xs text-fg-subtle">
              You sign in with this email.
            </p>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-fg-muted">
              Role
            </dt>
            <dd className="mt-1">
              <span className="inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-xs font-medium text-gold-strong">
                Coach
              </span>
            </dd>
          </div>
        </dl>

        <p className="mt-4 border-t border-line pt-3 text-xs text-fg-subtle">
          These details aren&apos;t editable here — contact PFA to change your
          email or role.
        </p>
      </section>

      {/* Coach Guide */}
      <section
        aria-labelledby="guide-heading"
        className="mb-10 rounded-2xl border border-line bg-surface px-6 py-5 shadow-[var(--shadow-sm)]"
      >
        <div className="flex items-center gap-2 text-fg-muted">
          <BookOpen className="h-4 w-4" />
          <p
            id="guide-heading"
            className="text-[11px] uppercase tracking-[0.14em] text-fg-muted"
          >
            Help
          </p>
        </div>
        <p className="mt-3 text-sm text-fg-muted">
          New here or need a refresher? Read the Coach Guide.
        </p>
        <Link
          href="/coach-guide"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-gold px-4 py-2 text-sm font-medium text-gold-ink shadow-[var(--shadow-sm)] transition hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
        >
          <BookOpen className="h-4 w-4" />
          Open Coach Guide
        </Link>
      </section>

      {/* Sign out */}
      <section aria-label="Sign out" className="mb-4">
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-fg-muted shadow-[var(--shadow-sm)] transition hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </form>
      </section>
    </div>
  );
}
