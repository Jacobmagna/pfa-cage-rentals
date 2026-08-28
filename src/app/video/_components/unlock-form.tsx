"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { unlockDisplay } from "../actions";
import { UNLOCK_INITIAL_STATE, type UnlockState } from "../unlock-state";

// The password box on /video.
//
// 🔴 THIS IS A CLIENT COMPONENT AND IT RECEIVES NOTHING. That is a security
// property, not an accident of the API. Props handed to a client component are
// serialized into the RSC payload and are readable by anyone who can load the
// page (probed and measured — see the header of lib/server/display-schedule.ts).
// This component is rendered to people who have NOT been let in yet, so it must
// never be handed the schedule, the password, or the configured state. The page
// does not fetch anything before the gate passes, which is what makes that true
// rather than merely intended.
//
// ⚠️ IT IS ALSO WHY THE ERROR STRINGS LIVE IN THE ACTION, not here: the copy is
// deliberately identical for every refusal so the box cannot be used to
// enumerate whether a display is configured.

export function UnlockForm() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<UnlockState, FormData>(
    unlockDisplay,
    UNLOCK_INITIAL_STATE,
  );

  // 🔴 IDENTITY, NOT A `pending` LATCH. The obvious version watches pending go
  // true-then-false, which needs React to actually render an intermediate
  // state — against a fast local action it can resolve inside one batch, the
  // latch never sets, and the screen sits on the password box after a
  // SUCCESSFUL unlock, reading as a failure. That exact bug shipped in this
  // repo's admin hour-entry dialog (discipline rule 43). `useActionState`
  // returns the initial object BY IDENTITY until an action resolves, so this
  // is an exact, timing-free statement of "a submit succeeded".
  useEffect(() => {
    if (state !== UNLOCK_INITIAL_STATE && state.ok) router.refresh();
  }, [state, router]);

  return (
    <main className="flex h-screen flex-col items-center justify-center bg-neutral-950 px-6 text-neutral-100">
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-bold tracking-tight">PFA facility schedule</h1>
        {/* Says what this screen IS. Someone walking past a TV showing a lone
            password box should be able to tell "this display needs unlocking"
            from "this display is broken" — different problems, different fixes,
            and only one of them needs Mark. */}
        <p className="mt-2 text-lg text-neutral-400">
          Enter the display password to show the schedule on this screen.
        </p>

        <form action={formAction} className="mt-8">
          <label htmlFor="display-password" className="sr-only">
            Display password
          </label>
          <input
            id="display-password"
            name="password"
            type="password"
            autoComplete="off"
            autoFocus
            required
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-xl text-neutral-100 outline-none focus:border-neutral-400"
          />
          <button
            type="submit"
            disabled={pending}
            className="mt-4 w-full rounded-lg bg-neutral-100 px-4 py-3 text-xl font-semibold text-neutral-900 disabled:opacity-60"
          >
            {pending ? "Checking…" : "Show the schedule"}
          </button>
        </form>

        {state.error ? (
          <p role="alert" className="mt-4 text-lg text-red-400">
            {state.error}
          </p>
        ) : null}

        {/* The reassurance that stops a second person unlocking it again next
            week and concluding it did not stick. */}
        <p className="mt-8 text-sm text-neutral-500">
          This screen only needs the password once. It stays signed in.
        </p>
      </div>
    </main>
  );
}
