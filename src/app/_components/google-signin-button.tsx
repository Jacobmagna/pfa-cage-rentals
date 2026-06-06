"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

/**
 * Client-side Google sign-in button.
 *
 * Why client component: Auth.js v5 (next-auth@5.0.0-beta.31) has a known bug
 * where the server-action `signIn("google")` silently fails on Next.js 16
 * with an internal Configuration error.
 * See https://github.com/nextauthjs/next-auth/issues/13388
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
      className="w-full rounded-lg bg-yellow text-black h-10 px-4 text-sm font-medium transition-colors hover:bg-yellow/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? "Redirecting…" : "Continue with Google"}
    </button>
  );
}
