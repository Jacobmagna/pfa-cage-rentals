"use client";

import { SessionProvider, signIn } from "next-auth/react";
import { useState } from "react";

// Travel Google sign-in button. Mirrors the facility GoogleSignInButton
// (client-side signIn — Auth.js v5 has a known server-action signIn("google")
// bug on Next 16). The SessionProvider wrapper points next-auth/react's client
// at the TRAVEL auth basePath so the sign-in POST hits /travel/api/auth, not
// the facility /api/auth.
function GoogleButton() {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        setPending(true);
        signIn("google", { callbackUrl: "/travel" });
      }}
      className="w-full rounded-lg bg-yellow text-black h-10 px-4 text-sm font-medium transition-colors hover:bg-yellow/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {pending ? "Redirecting…" : "Continue with Google"}
    </button>
  );
}

export function TravelGoogleSignInButton() {
  return (
    <SessionProvider basePath="/travel/api/auth">
      <GoogleButton />
    </SessionProvider>
  );
}
