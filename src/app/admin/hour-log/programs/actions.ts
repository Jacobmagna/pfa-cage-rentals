"use server";

// Admin-side public server actions for programs. Thin authz wrappers
// around the internal logic in src/lib/server/program-actions.ts. Every
// async export in a "use server" file is a public RPC endpoint, so this
// file deliberately ONLY exposes the requireRole("admin")-gated paths.
//
// Each action revalidates /admin/hour-log/programs so the table + badges reflect
// the mutation on the next render.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import {
  createProgramInternal,
  deactivateProgramInternal,
  updateProgramInternal,
} from "@/lib/server/program-actions";
import { revalidateWorkPaySurfaces } from "@/lib/server/pay-surface-revalidation";
import { updateProgramWithRepriceInternal } from "@/lib/server/rate-effective-dating-actions";
import { previewRateReprice } from "@/lib/server/rate-reprice";
import { readProgramDefaultRateHistory } from "@/lib/server/rate-history";

export async function createProgram(input: unknown) {
  const session = await requireRole("admin");
  const result = await createProgramInternal(session.user, input);
  revalidatePath("/admin/hour-log/programs");
  return result;
}

export async function updateProgram(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updateProgramInternal(session.user, id, input);
  revalidatePath("/admin/hour-log/programs");
  return result;
}

// ── SPEC rate-effective-dating Phase C — RETROACTIVE RE-PRICE ───────────
//
// Both actions below are gated by plain requireRole("admin") — SPEC decision
// §10.2, no new permission concept. The safety is the preview plus the
// server-side decrease guard, not the role gate.

/**
 * READ-ONLY. The §6 "preview before commit" diff for giving a PROGRAM DEFAULT
 * a past effective date: how many logs move, by how much, and — the half Mark
 * has to see per §6 — `excludedCoaches`, the coaches this retro structurally
 * cannot reach because their logs resolve from their own override (§5).
 * Writes nothing, so no revalidation.
 *
 * SPEC §7 (Phase D1) — the payload may carry an optional `candidateRate`
 * (`{ kind: "program_default", payMode, defaultRatePer30MinCents,
 * defaultPerSessionRateCents }`): the rate the admin has TYPED but not yet
 * saved. With it the engine substitutes that hypothetical PROGRAM pay config
 * and answers "what WOULD this rate do", so the inline preview quotes the
 * number that is actually about to be written. Without it, nothing changes.
 *
 * ⚠️ A program-default candidate replaces the PROGRAM's config and nothing
 * else — never a coach's override row. So SPEC §5 is untouched by it: an
 * override coach still resolves at step 1, is still unreachable whatever rate
 * is typed, and still comes back named on `excludedCoaches`.
 */
export async function previewProgramDefaultRateReprice(input: unknown) {
  await requireRole("admin");
  // Passed through whole: previewRateReprice parses it with
  // rateRepricePreviewInputSchema, the only schema carrying `candidateRate`.
  return previewRateReprice(input);
}

/**
 * Save a program AND, if `defaultRateEffectiveFrom` was supplied, re-price the
 * already-logged hours on it from that date forward.
 *
 * With no effective date this is `updateProgram` above, exactly — same
 * internal, same revalidation, no engine call.
 *
 * SPEC §5 holds through this action without a filter: a coach with their own
 * override on this program resolves at step 1 and the program default is never
 * consulted for their logs, so the retro cannot touch them whatever date is
 * picked. They come back named on `reprice.preview.excludedCoaches`.
 *
 * 🔴 Throws RateRepriceDecreaseNotConfirmedError (with the computed preview
 * attached) if the re-price would LOWER anyone's already-logged pay and the
 * payload did not carry `confirmDecrease: true`. The diff behind that refusal
 * is recomputed on the server; a preview supplied by the caller is never read.
 */
export async function updateProgramWithReprice(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updateProgramWithRepriceInternal(
    session.user,
    id,
    input,
  );
  revalidatePath("/admin/hour-log/programs");
  revalidateWorkPaySurfaces();
  // A program-default retro can move pay for MANY coaches, so bust every
  // coach-detail render, not one id. The route-pattern form is how Next
  // revalidates all dynamic segments of a page at once.
  revalidatePath("/admin/coaches/[id]", "page");
  revalidatePath("/admin/coaches");
  return result;
}

/**
 * READ-ONLY. SPEC §7 — the rate history behind the 3-dot menu beside this
 * program's default rate: every change newest-first, sourced from the
 * `default_rate_effective_from` column plus the existing audit trail.
 *
 * Admin-gated here rather than in the component: the 3-dot menu is a client
 * component and is handed this function, so it never touches a database of
 * its own.
 */
export async function getProgramDefaultRateHistory(programId: string) {
  await requireRole("admin");
  return readProgramDefaultRateHistory(programId);
}

export async function deactivateProgram(id: string) {
  const session = await requireRole("admin");
  const result = await deactivateProgramInternal(session.user, id);
  revalidatePath("/admin/hour-log/programs");
  return result;
}
