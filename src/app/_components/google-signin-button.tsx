"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

/**
 * Client-side Google sign-in button.
 *
 * Why client component: Auth.js v5 (next-auth@5.0.0-beta.31) has a known bug
 * where the server-action `signIn("google")` silently fails on Next.js 16
 * with an internal Configuration error — the button does nothing visible.
 * See https://github.com/nextauthjs/next-auth/issues/13388
 *
 * The client-side `signIn` from `next-auth/react` uses a different code path
 * that's unaffected. Magic-link via Resend continues to work via server action
 * (different code path) so only this button needs the client treatment.
 */
export function GoogleSignInButton() {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setPending(true);
        signIn("google", { callbackUrl: "/" });
      }}
      className="w-full rounded-md border border-foreground/15 bg-foreground/[0.03] px-4 py-2.5 text-sm font-medium hover:bg-foreground/[0.06] transition disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? "Redirecting…" : "Continue with Google"}
    </button>
  );
}
