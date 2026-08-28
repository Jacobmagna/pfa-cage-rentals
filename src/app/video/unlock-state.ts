// The unlock form's state shape and its copy.
//
// 🔴 THIS IS A SEPARATE MODULE FOR A HARD REASON, NOT FOR TIDINESS. `actions.ts`
// carries `"use server"`, and a "use server" file may export ONLY async
// functions — exporting the initial-state OBJECT from it crashes the route at
// module evaluation with:
//
//     Error: A "use server" file can only export async functions, found object.
//
// That is a 500 on submit, not a build error: everything typechecks, the page
// renders fine, and it only detonates when somebody presses the button. Found
// exactly that way (discipline rule 8) rather than by any assertion.
//
// 📌 Same constraint that produced `@/lib/program-stipend-field` and
// `@/lib/rate-input` elsewhere in this repo — non-function exports and
// unit-testable logic both have to live outside the "use server" boundary.

export type UnlockState = { ok: boolean; error: string | null };

/**
 * 🔴 COMPARED BY IDENTITY, so it must be a module-level singleton.
 * `unlock-form.tsx` decides "a submit has actually resolved" with
 * `state !== UNLOCK_INITIAL_STATE`, which is only meaningful while this object
 * is created once. Inlining it, or building it in a function, silently turns
 * that check into "always true" and the form would refresh on first paint.
 */
export const UNLOCK_INITIAL_STATE: UnlockState = { ok: false, error: null };

/**
 * 🔴 ONE MESSAGE FOR EVERY REFUSAL, DELIBERATELY.
 *
 * A wrong password, an unconfigured `DISPLAY_PASSWORD`, and a missing
 * `DISPLAY_TOKEN` all say exactly this. The instinct to be specific — right
 * everywhere else in this product — is wrong on the one route facing the open
 * internet: distinct errors let whoever is probing enumerate whether a display
 * exists and whether it is configured. Keep them identical.
 */
export const UNLOCK_REFUSED = "That password did not work. Try again.";

/**
 * The one refusal that IS distinguishable, and it earns it. Leaking that a
 * limiter exists changes nothing an attacker can act on, while withholding it
 * would strand Mark in front of a box silently refusing a password he is
 * typing correctly.
 */
export const UNLOCK_SLOW_DOWN = "Too many attempts. Wait a few minutes and try again.";
