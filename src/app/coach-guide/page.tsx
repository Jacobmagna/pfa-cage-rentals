import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "PFA Engine — Coach's Guide",
  description:
    "Everything PFA coaches need to book the cages, see their schedule, log hours, and take attendance — in one place.",
  robots: { index: false },
};

// Inline component "chips" mirroring the source guide's .tab / .btn / .lbl pills.
function Tab({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded bg-black px-2 font-semibold text-white">
      {children}
    </span>
  );
}

function Btn({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded bg-gold px-2 font-semibold text-gold-ink">
      {children}
    </span>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded border border-line-strong bg-surface-2 px-2 font-semibold text-fg">
      {children}
    </span>
  );
}

function Link2({ children }: { children: React.ReactNode }) {
  // Inline pfaengine.com link → points at the sign-in page (/).
  return (
    <Link
      href="/"
      className="font-semibold text-fg underline decoration-gold decoration-2 underline-offset-2 hover:decoration-fg"
    >
      {children}
    </Link>
  );
}

function SectionNum({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-black text-base font-extrabold text-gold">
      {children}
    </span>
  );
}

function Callout({
  variant = "warm",
  children,
}: {
  variant?: "warm" | "note";
  children: React.ReactNode;
}) {
  const cls =
    variant === "note"
      ? "border-line-strong bg-surface-2"
      : "border-gold/30 bg-gold/10";
  return (
    <div className={`my-5 rounded-xl border ${cls} px-4 py-3.5 text-base`}>
      {children}
    </div>
  );
}

function CalloutTitle({ children }: { children: React.ReactNode }) {
  return <span className="mb-0.5 block font-extrabold text-fg">{children}</span>;
}

// Numbered "steps" list with the source's circled step badges.
function Steps({ children }: { children: React.ReactNode }) {
  return (
    <ol className="m-0 list-none p-0 [counter-reset:step]">{children}</ol>
  );
}

function Step({ children }: { children: React.ReactNode }) {
  return (
    <li className="relative m-0 pb-4 pl-11 last:pb-0 [counter-increment:step] before:absolute before:left-0 before:top-0 before:flex before:h-[30px] before:w-[30px] before:items-center before:justify-center before:rounded-full before:border before:border-line-strong before:bg-surface-2 before:text-[15px] before:font-extrabold before:text-fg before:content-[counter(step)]">
      {children}
    </li>
  );
}

function Swatch({ className }: { className: string }) {
  return (
    <span
      className={`mr-1.5 inline-block h-3 w-3 rounded-[3px] border border-line-strong align-middle ${className}`}
    />
  );
}

export default function CoachGuidePage() {
  return (
    <main className="bg-page text-fg">
      {/* ============ COVER ============ */}
      <div className="bg-black px-6 pb-[52px] pt-14 text-center text-white">
        <Image
          src="/pfa-engine-logo.png"
          width={1672}
          height={941}
          alt="PFA Engine"
          priority
          className="mx-auto mb-6 h-auto w-60 sm:w-80"
        />
        <p className="mb-2 text-[13px] font-bold uppercase tracking-[0.22em] text-gold">
          For PFA Coaches
        </p>
        <h1 className="mb-3.5 text-[32px] font-extrabold leading-[1.1] tracking-tight sm:text-[42px]">
          Coach&apos;s Guide
        </h1>
        <p className="mx-auto mb-7 max-w-[520px] text-[17px] text-white/80">
          Everything you need to book the cages, see your schedule, log your
          hours, and take attendance — all in one place.
        </p>
        <Link
          href="/"
          className="inline-block rounded-[10px] bg-gold px-6 py-3.5 text-[17px] font-extrabold text-gold-ink transition-colors hover:bg-gold-hover"
        >
          Open PFA Engine →
        </Link>
        <span className="mt-3 block text-[13px] text-white/40">
          pfaengine.com
        </span>
      </div>

      {/* ============ BODY ============ */}
      <div className="mx-auto max-w-3xl px-5 pb-16 sm:px-6">
        {/* Intro band */}
        <div className="my-7 rounded-2xl border border-line bg-surface px-6 py-6">
          <p className="mb-3 leading-relaxed">
            <strong className="font-semibold text-fg">Welcome.</strong> PFA
            Engine is your private reservation and work system — built by PFA
            for the coaches who train with us. It runs in any web browser on
            your phone or computer; there&apos;s nothing to download.
          </p>
          <p className="leading-relaxed">
            This guide walks through everything you&apos;ll do day to day. Each
            step tells you exactly what to click. Whenever you want to jump in,
            just go to <Link2>pfaengine.com</Link2>.
          </p>
        </div>

        {/* TOC */}
        <nav className="my-7 rounded-2xl border border-line bg-surface-2 px-6 py-6">
          <h2 className="mb-3.5 text-sm uppercase tracking-[0.14em] text-fg-muted">
            What&apos;s inside
          </h2>
          <ol className="m-0 list-none p-0 [counter-reset:toc]">
            {[
              ["#signin", "Signing in"],
              ["#tabs", "Finding your way around"],
              ["#book", "Booking a cage rental"],
              ["#schedule", "Checking your schedule"],
              ["#worklog", "Logging your work hours"],
              ["#attendance", "Taking attendance"],
              ["#owe", "Seeing what you owe PFA"],
              ["#fix", "Fixing or canceling a rental"],
              ["#help", "Tips & getting help"],
            ].map(([href, label]) => (
              <li key={href} className="[counter-increment:toc]">
                <a
                  href={href}
                  className="flex items-center gap-3 border-b border-line py-2.5 font-semibold text-fg last:border-b-0 hover:text-black"
                >
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-gold text-sm font-extrabold text-gold-ink before:content-[counter(toc)]" />
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* ============ 1. SIGN IN ============ */}
        <section
          id="signin"
          className="my-5 scroll-mt-4 rounded-2xl border border-line bg-surface p-6 sm:p-7"
        >
          <h2 className="mb-1.5 flex items-center gap-3 text-2xl font-extrabold tracking-tight">
            <SectionNum>1</SectionNum> Signing in
          </h2>
          <p className="mb-4 text-fg-muted">
            PFA Engine is invite-only — PFA adds your email ahead of time, so you
            just sign in with it.
          </p>
          <Steps>
            <Step>
              Go to <Link2>pfaengine.com</Link2> in any browser (Chrome, Safari,
              etc.).
            </Step>
            <Step>
              Click <Btn>Continue with Google</Btn> and choose the Google
              account on the email PFA invited.
            </Step>
            <Step>
              That&apos;s it — you&apos;re in. The next time you visit, it
              usually remembers you.
            </Step>
          </Steps>
          <Callout variant="note">
            <CalloutTitle>No Google account on that email?</CalloutTitle>
            Click <Lbl>Send me a sign-in link</Lbl> instead. We&apos;ll email you
            a one-tap link that signs you in — no password to remember.
          </Callout>
          <Callout>
            <CalloutTitle>
              Seeing &quot;This email isn&apos;t authorized yet&quot;?
            </CalloutTitle>
            That just means PFA hasn&apos;t added that exact address. Let PFA
            know which email you want to use and try again once they confirm
            it&apos;s added.
          </Callout>
        </section>

        {/* ============ 2. TABS ============ */}
        <section
          id="tabs"
          className="my-5 scroll-mt-4 rounded-2xl border border-line bg-surface p-6 sm:p-7"
        >
          <h2 className="mb-1.5 flex items-center gap-3 text-2xl font-extrabold tracking-tight">
            <SectionNum>2</SectionNum> Finding your way around
          </h2>
          <p className="mb-4 text-fg-muted">
            Once you&apos;re in, there are four tabs along the top. That&apos;s
            the whole app.
          </p>
          <ul className="my-2 list-disc space-y-1.5 pl-5">
            <li>
              <Tab>Rentals</Tab> — book a cage (or bullpen / weight room) and
              review the ones you&apos;ve booked.
            </li>
            <li>
              <Tab>Work Log</Tab> — log the hours you worked, or confirm hours
              that were already on your schedule.
            </li>
            <li>
              <Tab>Attendance</Tab> — check off which athletes showed up to a
              session.
            </li>
            <li>
              <Tab>Schedule</Tab> — see your week at a glance: your work blocks
              and your cage rentals together.
            </li>
          </ul>
          <Callout variant="note">
            <CalloutTitle>On your phone?</CalloutTitle>
            The same four tabs are there — they sit in the menu at the top and
            everything works the same way, just stacked for a smaller screen.
          </Callout>
        </section>

        {/* ============ 3. BOOK ============ */}
        <section
          id="book"
          className="my-5 scroll-mt-4 rounded-2xl border border-line bg-surface p-6 sm:p-7"
        >
          <h2 className="mb-1.5 flex items-center gap-3 text-2xl font-extrabold tracking-tight">
            <SectionNum>3</SectionNum> Booking a cage rental
          </h2>
          <p className="mb-4 text-fg-muted">
            This is the calendar where you reserve a cage. Open slots are free to
            grab; red ones are already taken.
          </p>
          <Steps>
            <Step>
              Click the <Tab>Rentals</Tab> tab, then <Btn>Log a cage rental</Btn>{" "}
              (or the <Lbl>Log rental</Lbl> button).
            </Step>
            <Step>
              Use the day arrows or the <Lbl>Today</Lbl> button to land on the
              day you want.
            </Step>
            <Step>
              You&apos;ll see a grid: each row is a resource (Cage 1, Bullpen,
              Weight Room…) and each column is a 30-minute time slot.
            </Step>
            <Step>
              Tap an <strong className="font-semibold">open</strong> slot. A bar
              appears at the top of the screen showing what you picked.
            </Step>
            <Step>
              Click <Btn>Schedule</Btn>. A booking window opens.
            </Step>
            <Step>
              Pick how long you need — <Lbl>30 min</Lbl>, <Lbl>1 hr</Lbl>, or a
              custom length (only up to the next taken slot). Add a note if you
              like.
            </Step>
            <Step>
              Click <Btn>Schedule</Btn> to confirm. Your slot turns{" "}
              <span className="font-bold text-gold-strong">yellow</span> — that
              means it&apos;s yours.
            </Step>
          </Steps>

          <h3 className="mb-2 mt-5 text-lg font-bold">
            Booking several slots at once
          </h3>
          <ul className="my-2 list-disc space-y-1.5 pl-5">
            <li>
              Click <Lbl>Select multiple slots</Lbl>, then tap each open slot you
              want <em>in the same row</em>.
            </li>
            <li>
              When you&apos;ve got them all, click <Btn>Schedule</Btn> to book
              them together.
            </li>
          </ul>

          <Callout>
            <CalloutTitle>Prefer typing it in?</CalloutTitle>
            Click <Lbl>Prefer the form?</Lbl> at the top to switch to a simple
            form — pick the date, start and end time, and resource, then submit.
            Same result, no grid.
          </Callout>

          <Callout variant="note">
            <CalloutTitle>What the colors mean</CalloutTitle>
            <Swatch className="bg-surface" />
            <strong className="font-semibold">Open</strong> — free to book &nbsp;·&nbsp;
            <Swatch className="bg-gold" />
            <strong className="font-semibold">Yellow</strong> — your booking &nbsp;·&nbsp;
            <Swatch className="bg-danger" />
            <strong className="font-semibold">Red</strong> — taken or blocked
          </Callout>
        </section>

        {/* ============ 4. SCHEDULE ============ */}
        <section
          id="schedule"
          className="my-5 scroll-mt-4 rounded-2xl border border-line bg-surface p-6 sm:p-7"
        >
          <h2 className="mb-1.5 flex items-center gap-3 text-2xl font-extrabold tracking-tight">
            <SectionNum>4</SectionNum> Checking your schedule
          </h2>
          <p className="mb-4 text-fg-muted">
            One screen that shows your whole week — both the work PFA has you
            scheduled for and the cages you&apos;ve booked.
          </p>
          <Steps>
            <Step>
              Click the <Tab>Schedule</Tab> tab.
            </Step>
            <Step>
              You&apos;ll see the week laid out — days across the top, times down
              the side. Your work blocks and your rentals both show up here.
            </Step>
            <Step>
              Use the arrows to move to last week or next week. (On your phone it
              shows as a simple day-by-day list.)
            </Step>
          </Steps>
          <Callout variant="note">
            <CalloutTitle>Nothing there?</CalloutTitle>
            If the week is empty you&apos;ll see &quot;Nothing scheduled this
            week.&quot; Check that you&apos;re on the right week with the arrows.
          </Callout>
        </section>

        {/* ============ 5. WORK LOG ============ */}
        <section
          id="worklog"
          className="my-5 scroll-mt-4 rounded-2xl border border-line bg-surface p-6 sm:p-7"
        >
          <h2 className="mb-1.5 flex items-center gap-3 text-2xl font-extrabold tracking-tight">
            <SectionNum>5</SectionNum> Logging your work hours
          </h2>
          <p className="mb-4 text-fg-muted">
            This is how PFA knows the hours you worked so you get paid for them.
            There are two easy ways.
          </p>

          <h3 className="mb-2 mt-5 text-lg font-bold">
            The fast way — confirm what was scheduled
          </h3>
          <Steps>
            <Step>
              Click the <Tab>Work Log</Tab> tab (you&apos;ll land on{" "}
              <Lbl>Log work</Lbl>).
            </Step>
            <Step>
              At the top you&apos;ll see your recent scheduled blocks that
              haven&apos;t been logged yet. Each shows the program and the time.
            </Step>
            <Step>
              For one that happened, just tap to confirm it — it&apos;s logged in
              one click.
            </Step>
          </Steps>
          <Callout variant="note">
            <CalloutTitle>&quot;Overdue&quot; tag?</CalloutTitle>
            That just means a scheduled block ended a while ago and still
            hasn&apos;t been confirmed. Confirm it (or, if it didn&apos;t happen,
            use the cancel option to clear it).
          </Callout>

          <h3 className="mb-2 mt-5 text-lg font-bold">
            The manual way — log hours yourself
          </h3>
          <Steps>
            <Step>
              In the <Lbl>Log work</Lbl> tab, scroll to{" "}
              <strong className="font-semibold">Log your hours</strong>.
            </Step>
            <Step>
              Pick the program, set the start and end time, add a note if needed.
            </Step>
            <Step>Submit. Done.</Step>
          </Steps>
          <Callout>
            <CalloutTitle>
              Logging something that wasn&apos;t on your schedule?
            </CalloutTitle>
            That&apos;s allowed — it just gets flagged for PFA to review, which is
            normal. Log it and carry on.
          </Callout>
          <p className="mt-4 text-fg-muted">
            Want to see everything you&apos;ve logged? Click the{" "}
            <Lbl>History</Lbl> sub-tab.
          </p>
        </section>

        {/* ============ 6. ATTENDANCE ============ */}
        <section
          id="attendance"
          className="my-5 scroll-mt-4 rounded-2xl border border-line bg-surface p-6 sm:p-7"
        >
          <h2 className="mb-1.5 flex items-center gap-3 text-2xl font-extrabold tracking-tight">
            <SectionNum>6</SectionNum> Taking attendance
          </h2>
          <p className="mb-4 text-fg-muted">
            Check off who showed up to a session in a few taps.
          </p>
          <Steps>
            <Step>
              Click the <Tab>Attendance</Tab> tab.
            </Step>
            <Step>Pick the program and the date at the top.</Step>
            <Step>
              A checklist of the athletes in that program appears. Check the ones
              who were there.
            </Step>
            <Step>Submit to save it.</Step>
          </Steps>
          <Callout variant="note">
            <CalloutTitle>Empty list?</CalloutTitle>
            If no athletes show up, that program may not have anyone assigned yet
            — let a PFA admin know.
          </Callout>
        </section>

        {/* ============ 7. OWE ============ */}
        <section
          id="owe"
          className="my-5 scroll-mt-4 rounded-2xl border border-line bg-surface p-6 sm:p-7"
        >
          <h2 className="mb-1.5 flex items-center gap-3 text-2xl font-extrabold tracking-tight">
            <SectionNum>7</SectionNum> Seeing what you owe PFA
          </h2>
          <p className="mb-4 text-fg-muted">
            Your home screen shows a running total of what you owe PFA for the
            cages you&apos;ve rented.
          </p>
          <ul className="my-2 list-disc space-y-1.5 pl-5">
            <li>
              On the <Tab>Rentals</Tab> home screen, look for the card{" "}
              <strong className="font-semibold">
                &quot;What you owe PFA — cage rentals.&quot;
              </strong>
            </li>
            <li>
              It shows your total rentals billed and any payments PFA has
              recorded — so the balance is always current.
            </li>
          </ul>
          <Callout variant="note">
            <CalloutTitle>
              Two different things — don&apos;t mix them up
            </CalloutTitle>
            <strong className="font-semibold">Cage rentals</strong> = money{" "}
            <em>you pay PFA</em> (shown on this card).{" "}
            <strong className="font-semibold">Work hours</strong> = money{" "}
            <em>PFA pays you</em> — those are handled separately and aren&apos;t
            on this card. This card is read-only; pay PFA directly the usual way.
          </Callout>
        </section>

        {/* ============ 8. FIX ============ */}
        <section
          id="fix"
          className="my-5 scroll-mt-4 rounded-2xl border border-line bg-surface p-6 sm:p-7"
        >
          <h2 className="mb-1.5 flex items-center gap-3 text-2xl font-extrabold tracking-tight">
            <SectionNum>8</SectionNum> Fixing or canceling a rental
          </h2>
          <p className="mb-4 text-fg-muted">
            Booked the wrong slot or need to change a note? Your rentals are easy
            to manage.
          </p>
          <Steps>
            <Step>
              On the <Tab>Rentals</Tab> home screen, click <Lbl>My rentals</Lbl>{" "}
              to see your history.
            </Step>
            <Step>
              Find the rental. Use the{" "}
              <strong className="font-semibold">pencil</strong> to edit it, or
              the <strong className="font-semibold">trash</strong> to remove an
              upcoming one.
            </Step>
          </Steps>
          <Callout variant="note">
            <CalloutTitle>Already-past rentals</CalloutTitle>
            For rentals that have already happened, you can still fix the note,
            but the billable details are locked. If a past one needs to be
            removed, use &quot;Request removal&quot; and PFA will take care of it.
          </Callout>
        </section>

        {/* ============ 9. HELP ============ */}
        <section
          id="help"
          className="my-5 scroll-mt-4 rounded-2xl border border-line bg-surface p-6 sm:p-7"
        >
          <h2 className="mb-1.5 flex items-center gap-3 text-2xl font-extrabold tracking-tight">
            <SectionNum>9</SectionNum> Tips &amp; getting help
          </h2>
          <ul className="my-2 list-disc space-y-1.5 pl-5">
            <li>
              <strong className="font-semibold">Bookmark it.</strong> Save{" "}
              <Link2>pfaengine.com</Link2> to your phone&apos;s home screen so it
              opens like an app.
            </li>
            <li>
              <strong className="font-semibold">Log as you go.</strong> Confirming
              your hours the same day keeps everything accurate and gets you paid
              faster.
            </li>
            <li>
              <strong className="font-semibold">Open slots are first-come.</strong>{" "}
              If a cage time matters to you, grab it early.
            </li>
            <li>
              <strong className="font-semibold">Stuck on anything?</strong> Text
              or email Mark or Esther Magna and they&apos;ll get you sorted out.
            </li>
          </ul>
        </section>

        <footer className="mt-8 text-center text-sm text-fg-subtle">
          <strong className="text-fg">PFA Engine</strong> — built by PFA, for PFA
          coaches.
          <br />
          pfaengine.com
        </footer>
      </div>
    </main>
  );
}
