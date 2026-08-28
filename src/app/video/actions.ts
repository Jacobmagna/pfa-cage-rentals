"use server";

import { cookies, headers } from "next/headers";
import {
  DISPLAY_COOKIE_MAX_AGE_SECONDS,
  DISPLAY_COOKIE_NAME,
  displayCookieValue,
  isDisplayPasswordConfigured,
  isDisplayPasswordValid,
} from "@/lib/display/access";
import { checkDisplayUnlockRateLimit } from "@/lib/ratelimit";
import {
  UNLOCK_REFUSED,
  UNLOCK_SLOW_DOWN,
  type UnlockState,
} from "./unlock-state";

// The unlock action behind /video's password box.
//
// 🔴 THE SHAPE HERE IS DELIBERATE AND IS ABOUT WHAT AN ATTACKER LEARNS.
// Every refusal returns the SAME message. A gate that distinguishes "wrong
// password" from "this display is not configured" from "you have been rate
// limited" is a gate that answers questions for whoever is probing it — and
// the honest-error instinct that is right everywhere else in this product is
// wrong on the one route that faces the open internet.
//
// ⚠️ The single exception is the rate-limit case, which says to wait. That
// leaks that a limiter exists, which is fine: it changes nothing an attacker
// can act on, and withholding it would strand Mark in front of a box that
// silently refuses a password he is typing correctly.

// 🔴 NOTHING BUT THE ASYNC ACTION MAY BE EXPORTED FROM THIS FILE. A "use
// server" module may export only async functions; the state object and the
// copy live in ./unlock-state.ts for that reason. Adding a `const` export here
// crashes the route at module evaluation, and only on submit — see that file.

export async function unlockDisplay(
  _prev: UnlockState,
  formData: FormData,
): Promise<UnlockState> {
  const configured = process.env.DISPLAY_PASSWORD;
  const signingSecret = process.env.DISPLAY_TOKEN;

  // 🔴 RATE LIMIT BEFORE COMPARING, NOT AFTER. Checking the password first and
  // limiting afterwards would still let an attacker learn the answer on the
  // attempt that succeeds — the limiter has to gate the ORACLE, not the reply.
  const ip =
    (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await checkDisplayUnlockRateLimit(ip))) {
    return { ok: false, error: UNLOCK_SLOW_DOWN };
  }

  // Fails closed when unconfigured — and reports the same thing as a wrong
  // password, so an empty DISPLAY_PASSWORD cannot be discovered by probing.
  if (!isDisplayPasswordConfigured(configured)) return { ok: false, error: UNLOCK_REFUSED };

  // 🔴 A SIGNING SECRET IS REQUIRED TO ISSUE A COOKIE. Without DISPLAY_TOKEN
  // there is nothing to sign with, and the alternative — falling back to an
  // unsigned or password-keyed cookie — would be a weaker gate installed
  // silently by a missing environment variable. Refuse instead.
  if (typeof signingSecret !== "string" || signingSecret.length < 24) {
    return { ok: false, error: UNLOCK_REFUSED };
  }

  const supplied = formData.get("password");
  if (!isDisplayPasswordValid(typeof supplied === "string" ? supplied : undefined, configured)) {
    return { ok: false, error: UNLOCK_REFUSED };
  }

  (await cookies()).set({
    name: DISPLAY_COOKIE_NAME,
    value: displayCookieValue(signingSecret),
    // Not readable by JavaScript, so nothing on the page can echo it into the
    // DOM and no injected script can exfiltrate it.
    httpOnly: true,
    // 🔴 A YEAR, NOT A SESSION. A session cookie dies when the TV browser
    // restarts, which on a wall screen means a power cut leaves a password box
    // glowing over the cages — the exact failure this whole feature exists to
    // prevent (lib/display/access.ts, discipline rule 22).
    maxAge: DISPLAY_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    // Off in local dev, where the QA harness serves plain http on localhost.
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  return { ok: true, error: null };
}
