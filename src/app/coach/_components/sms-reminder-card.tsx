"use client";

// 1b #25 — coach-side SMS reminder UI. ONE component covers two states:
//
//   • promptAnswered === false  → the prominent first-login "Finish setting
//     up your account" card (phone input + opt-in choice + Save + Not now).
//     This is the consent surface Jacob screenshots for Twilio A2P 10DLC
//     verification, so the opt-in language is explicit and clearly optional.
//   • promptAnswered === true   → a compact "Text reminders" settings card
//     (current phone + a keyboard-operable on/off toggle, editable later).
//
// DORMANT-SAFE: this only collects a phone + a preference; nothing is sent
// and it renders fine with no Twilio env present. Saving is the only thing
// that stamps sms_prompt_answered_at (via the server action); "Not now"
// just hides the card for THIS view (client state) so it reappears next
// visit until the coach actually saves.
//
// Server contract (src/app/coach/actions.ts → src/lib/server/sms-actions.ts):
//   • saveSmsSetup({ optIn, phone }) — first-login save + later phone edits.
//   • setSmsOptIn({ optIn })         — later toggle (phone must be on file).
//   • both throw SmsPhoneRequiredError (code "SMS_PHONE_REQUIRED") when an
//     opt-in is attempted with no normalizable phone — caught here to show
//     an inline "add a phone number first" message.

import { useState, useTransition } from "react";
import { BellRing, MessageSquareText } from "lucide-react";
import { saveSmsSetup, setSmsOptIn } from "../actions";

const PHONE_REQUIRED_CODE = "SMS_PHONE_REQUIRED";

function isPhoneRequiredError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PHONE_REQUIRED_CODE
  );
}

export function SmsReminderCard({
  initialPhone,
  initialOptIn,
  initialPromptAnswered,
}: {
  initialPhone: string | null;
  initialOptIn: boolean;
  initialPromptAnswered: boolean;
}) {
  const [promptAnswered, setPromptAnswered] = useState(initialPromptAnswered);
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [optIn, setOptIn] = useState(initialOptIn);
  const [dismissed, setDismissed] = useState(false);
  const [editingPhone, setEditingPhone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Local draft state for the first-login form's opt-in choice. Kept
  // separate from the persisted `optIn` so toggling the choice before
  // saving doesn't read as a committed preference.
  const [draftOptIn, setDraftOptIn] = useState(initialOptIn);

  if (!promptAnswered && dismissed) return null;

  // ── First-login setup prompt ──────────────────────────────────────
  if (!promptAnswered) {
    const onSave = () => {
      setError(null);
      const trimmed = phone.trim();
      startTransition(async () => {
        try {
          const result = await saveSmsSetup({
            optIn: draftOptIn,
            phone: trimmed.length > 0 ? trimmed : undefined,
          });
          setPhone(result.phone ?? "");
          setOptIn(result.optIn);
          setPromptAnswered(true);
        } catch (err) {
          if (isPhoneRequiredError(err)) {
            setError(
              "Add a valid phone number above to turn on reminder texts.",
            );
          } else {
            setError(
              err instanceof Error
                ? err.message
                : "Could not save. Please try again.",
            );
          }
        }
      });
    };

    return (
      <section
        aria-labelledby="sms-setup-heading"
        className="mb-10 rounded-2xl border border-gold/40 bg-gradient-to-b from-[#fffdf8] to-[#fcf4e2] px-6 py-5 shadow-[var(--shadow-md)]"
      >
        <div className="flex items-center gap-2 text-gold-strong">
          <BellRing className="h-4 w-4" />
          <p className="text-[11px] uppercase tracking-[0.14em]">
            Finish setting up your account
          </p>
        </div>
        <h2
          id="sms-setup-heading"
          className="mt-3 text-xl font-semibold tracking-tight text-fg"
        >
          Want a text reminder if you forget to log work?
        </h2>
        <p className="mt-2 text-sm text-fg-muted leading-relaxed">
          PFA can send you a text message reminder if it looks like you had
          scheduled work but didn&apos;t log it. This is optional — you can
          turn it on or off any time. Standard message and data rates may
          apply; reply STOP to opt out.
        </p>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs uppercase tracking-wider text-fg-muted">
              Mobile phone number
            </span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              name="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={isPending}
              maxLength={32}
              placeholder="(555) 555-1234"
              className="w-full max-w-xs rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-gold/40 disabled:opacity-50"
            />
          </label>

          <div className="flex items-start gap-2.5">
            <input
              id="sms-consent"
              type="checkbox"
              checked={draftOptIn}
              disabled={isPending}
              onChange={(e) => {
                setDraftOptIn(e.target.checked);
                setError(null);
              }}
              className="mt-0.5 h-4 w-4 flex-none cursor-pointer accent-[var(--color-gold)] disabled:cursor-not-allowed disabled:opacity-50"
            />
            <label
              htmlFor="sms-consent"
              className="cursor-pointer text-xs text-fg-muted leading-snug"
            >
              I agree to receive account-notification text messages from PFA
              Engine (a daily reminder to log my coaching hours). Message
              frequency is about 1 message per day on days with unlogged hours.
              Message and data rates may apply. Reply STOP to opt out, HELP for
              help. See our{" "}
              <a
                href="/sms-terms"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-fg-muted underline underline-offset-2 hover:text-fg"
              >
                SMS Terms
              </a>{" "}
              and{" "}
              <a
                href="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-fg-muted underline underline-offset-2 hover:text-fg"
              >
                Privacy Policy
              </a>
              .
            </label>
          </div>
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gold px-4 py-2 text-sm font-medium text-gold-ink shadow-[var(--shadow-sm)] transition hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            disabled={isPending}
            className="text-sm font-medium text-fg-muted underline-offset-2 transition hover:text-fg hover:underline disabled:opacity-50"
          >
            Not now
          </button>
        </div>
      </section>
    );
  }

  // ── Compact "Text reminders" settings (after they've answered) ────
  const onToggle = (next: boolean) => {
    setError(null);
    // Optimistic flip; revert on failure.
    setOptIn(next);
    startTransition(async () => {
      try {
        const result = await setSmsOptIn({ optIn: next });
        setOptIn(result.optIn);
      } catch (err) {
        setOptIn(!next);
        if (isPhoneRequiredError(err)) {
          setError(
            "Add a phone number first — edit the number below, then try again.",
          );
        } else {
          setError(
            err instanceof Error
              ? err.message
              : "Could not update. Please try again.",
          );
        }
      }
    });
  };

  const onSavePhone = () => {
    setError(null);
    const trimmed = phone.trim();
    startTransition(async () => {
      try {
        const result = await saveSmsSetup({
          optIn,
          phone: trimmed.length > 0 ? trimmed : undefined,
        });
        setPhone(result.phone ?? "");
        setOptIn(result.optIn);
        setEditingPhone(false);
      } catch (err) {
        if (isPhoneRequiredError(err)) {
          setError("Enter a valid phone number to keep reminders on.");
        } else {
          setError(
            err instanceof Error
              ? err.message
              : "Could not save. Please try again.",
          );
        }
      }
    });
  };

  return (
    <section
      aria-labelledby="sms-settings-heading"
      className="mb-10 rounded-2xl border border-line bg-surface px-6 py-5 shadow-[var(--shadow-sm)]"
    >
      <div className="flex items-center gap-2 text-fg-muted">
        <MessageSquareText className="h-4 w-4" />
        <p
          id="sms-settings-heading"
          className="text-[11px] uppercase tracking-[0.14em] text-fg-muted"
        >
          Text reminders
        </p>
      </div>

      <div className="mt-4">
        <ReminderToggle
          checked={optIn}
          disabled={isPending}
          onChange={onToggle}
          label="Text me work reminders"
          description={
            optIn
              ? "On — we'll text you if you have unlogged scheduled work."
              : "Off — turn on to get a reminder for unlogged scheduled work."
          }
        />
        <ConsentNote className="mt-3" />
      </div>

      <div className="mt-4 border-t border-line pt-4">
        {!editingPhone ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-fg-muted">
              Phone on file:{" "}
              <span className="font-medium text-fg">
                {phone.trim().length > 0 ? phone : "none"}
              </span>
            </p>
            <button
              type="button"
              onClick={() => {
                setEditingPhone(true);
                setError(null);
              }}
              disabled={isPending}
              className="text-xs font-medium text-fg-muted underline-offset-2 transition hover:text-fg hover:underline disabled:opacity-50"
            >
              {phone.trim().length > 0 ? "Change" : "Add"}
            </button>
          </div>
        ) : (
          <label className="block">
            <span className="mb-1.5 block text-xs uppercase tracking-wider text-fg-muted">
              Mobile phone number
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                name="phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={isPending}
                maxLength={32}
                placeholder="(555) 555-1234"
                className="w-full max-w-xs rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-gold/40 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={onSavePhone}
                disabled={isPending}
                className="rounded-lg bg-gold px-3 py-2 text-xs font-medium text-gold-ink shadow-[var(--shadow-sm)] transition hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 disabled:opacity-50"
              >
                {isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingPhone(false);
                  setPhone(initialPhone ?? phone);
                  setError(null);
                }}
                disabled={isPending}
                className="rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs font-medium text-fg-muted shadow-[var(--shadow-sm)] transition hover:text-fg disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </label>
        )}
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

// Carrier-required consent microcopy shown in the settings card next to the
// returning-user opt-in toggle, with inline links to the full /sms-terms and
// /privacy pages. Text is complete per the A2P 10DLC brief.
function ConsentNote({ className }: { className?: string }) {
  return (
    <p className={`text-xs text-fg-subtle leading-snug ${className ?? ""}`}>
      Message and data rates may apply; about 1 message/day on days with
      unlogged hours. Reply STOP to opt out, HELP for help. See our{" "}
      <a
        href="/sms-terms"
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-fg-muted underline underline-offset-2 hover:text-fg"
      >
        SMS Terms
      </a>{" "}
      and{" "}
      <a
        href="/privacy"
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-fg-muted underline underline-offset-2 hover:text-fg"
      >
        Privacy Policy
      </a>
      .
    </p>
  );
}

// Accessible on/off toggle: a real <button role="switch"> with aria-checked,
// keyboard-operable (Space/Enter via native button activation), labeled via
// the visible text it sits beside.
function ReminderToggle({
  checked,
  disabled,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs text-fg-subtle leading-snug">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          "relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-gold" : "bg-line-strong",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={[
            "inline-block h-5 w-5 transform rounded-full bg-white shadow-[var(--shadow-sm)] transition-transform",
            checked ? "translate-x-5" : "translate-x-0.5",
          ].join(" ")}
        />
      </button>
    </div>
  );
}
