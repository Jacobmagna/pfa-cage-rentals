"use server";

// Public server actions for per-coach rate overrides. Thin authz
// wrappers around src/lib/server/rate-override-actions.ts. Every
// async export here is exposed as a public RPC endpoint, so this
// file deliberately ONLY exposes the requireRole("admin")-gated
// paths.
//
// Revalidation invariant: both mutations revalidate the coach detail
// page (so the override list re-renders) AND /admin/coaches (so the
// list page's "owed this month" recomputes against the new rate).
// Direct callers get correct behavior; form-action wrappers don't
// double-revalidate.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import type { ResourceType } from "@/lib/billing";
import { CoachArchivedError } from "@/lib/errors";
import {
  deleteRateOverrideInternal,
  upsertRateOverrideInternal,
} from "@/lib/server/rate-override-actions";
import {
  deleteProgramRateOverrideInternal,
  upsertProgramRateOverrideInternal,
} from "@/lib/server/program-rate-override-actions";
import { upsertProgramRateOverrideWithRepriceInternal } from "@/lib/server/rate-effective-dating-actions";
import { previewRateReprice } from "@/lib/server/rate-reprice";
import { readProgramRateOverrideHistory } from "@/lib/server/rate-history";
import { revalidateWorkPaySurfaces } from "@/lib/server/pay-surface-revalidation";
import {
  archiveCoachInternal,
  deleteCoachInternal,
} from "@/lib/server/user-actions";
import { updateUserHandlesInternal } from "@/lib/server/handles-actions";
import { updateCoachNotesInternal } from "@/lib/server/coach-notes-actions";
import { updateCoachPaySettingsInternal } from "@/lib/server/coach-pay-settings-actions";
import { setScheduleAdminInternal } from "@/lib/server/schedule-admin-actions";
import { setScheduleAdminSchema } from "@/lib/schemas/user";

// QA-2 write guard (defense in depth). The coach-detail page is now
// REACHABLE for archived coaches (read-only render), so UI-hiding alone
// isn't enough — a forged direct RPC call could still target an archived
// coach. Every MUTATING action below loads the target coach and rejects
// the write if it's archived (deletedAt non-null). Restore is the ONE
// exception (it's how an archived coach comes back) and never calls this.
// Handles / notes / schedule-admin internals already re-check deletedAt in
// their own existing-lookup, but this guard is the uniform, explicit
// backstop across ALL mutations (including the override / pay-settings
// paths that key on their own tables and don't touch users.deletedAt).
async function assertCoachNotArchived(coachId: string): Promise<void> {
  const [target] = await db
    .select({ deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, coachId))
    .limit(1);
  // Unknown id → let the internal throw its own CoachNotFoundError; we
  // only reject the specifically-archived case here.
  if (target && target.deletedAt !== null) {
    throw new CoachArchivedError(coachId);
  }
}

function revalidateOverrideSurfaces(coachId: string) {
  revalidatePath(`/admin/coaches/${coachId}`);
  revalidatePath("/admin/coaches");
  // /admin/reports rate column also derives from overrides — but it's
  // a fully-dynamic searchParams page, no stale cache to bust.
}

// Pull a coachId out of an unknown action payload for the archived-coach
// guard. Best-effort: a malformed payload with no usable coachId falls
// through (guard is a no-op) and the internal's Zod parse rejects it.
function coachIdFromInput(input: unknown): string | null {
  if (input && typeof input === "object" && "coachId" in input) {
    const v = (input as { coachId: unknown }).coachId;
    return typeof v === "string" ? v : null;
  }
  return null;
}

export async function upsertRateOverride(input: unknown) {
  const session = await requireRole("admin");
  const coachId = coachIdFromInput(input);
  if (coachId) await assertCoachNotArchived(coachId);
  const result = await upsertRateOverrideInternal(session.user, input);
  revalidateOverrideSurfaces(result.coachId);
  return result;
}

// Explicit args (matches deleteSession(id) / deleteBlock(id) convention).
// The internal still Zod-parses for defense-in-depth.
export async function deleteRateOverride(
  coachId: string,
  resourceType: ResourceType,
) {
  const session = await requireRole("admin");
  await assertCoachNotArchived(coachId);
  await deleteRateOverrideInternal(session.user, { coachId, resourceType });
  revalidateOverrideSurfaces(coachId);
}

// Per-coach PROGRAM rate overrides. Mirrors the resource-type override
// actions above but keyed on (coachId, programId). Both revalidate the
// coach detail page so the program-rate card re-renders.
export async function upsertProgramRateOverride(input: unknown) {
  const session = await requireRole("admin");
  const coachId = coachIdFromInput(input);
  if (coachId) await assertCoachNotArchived(coachId);
  const result = await upsertProgramRateOverrideInternal(session.user, input);
  revalidateOverrideSurfaces(result.coachId);
  return result;
}

// ── SPEC rate-effective-dating Phase C — RETROACTIVE RE-PRICE ───────────
//
// Both actions below are gated by plain requireRole("admin") — SPEC decision
// §10.2, no new permission concept. The safety is the preview plus the
// server-side decrease guard, not the role gate.

/**
 * READ-ONLY. The §6 "preview before commit" diff for giving THIS coach's
 * override on THIS program a past effective date: how many logs move, by how
 * much, and (for a program-scoped preview) which coaches the rule cannot
 * reach. Writes nothing — the engine's preview path is three SELECTs and a
 * pure function — so there is no revalidation and no archived-coach write
 * guard here.
 *
 * SPEC §7 (Phase D1) — the payload may carry an optional `candidateRate`
 * (`{ kind: "override", payMode, ratePer30MinCents, perSessionRateCents }`):
 * the rate the admin has TYPED but not yet saved. With it, the engine
 * substitutes that hypothetical override row for the persisted one and the
 * preview answers "what WOULD this rate do" — which is what makes an inline
 * preview before Save is armed honest, instead of quoting the old rate and
 * then writing a different number. Without it, this answers "what would
 * re-pricing to this date do with the rate already on the row", exactly as
 * before. It works for a coach with NO override row yet, which is the
 * first-time case the dialog most needs.
 *
 * The candidate is validated with the same rules as a real rate, so a rate
 * that could never be saved cannot be previewed. `applyRateReprice` still
 * refuses a candidate outright (type + runtime), so nothing here can turn a
 * hypothetical into a write.
 */
export async function previewProgramRateOverrideReprice(input: unknown) {
  await requireRole("admin");
  // Passed through whole: previewRateReprice parses it with
  // rateRepricePreviewInputSchema, which is the only schema that carries
  // `candidateRate`. Read-only — no revalidation, no archived-coach guard.
  return previewRateReprice(input);
}

/**
 * Save a per-coach program rate override AND, if an effective date in the
 * past was supplied, re-price that coach's already-logged hours on that
 * program from that date forward.
 *
 * With no effective date this is `upsertProgramRateOverride` above, exactly —
 * same internal, same revalidation, no engine call.
 *
 * 🔴 Throws RateRepriceDecreaseNotConfirmedError (with the computed preview
 * attached) if the re-price would LOWER anyone's already-logged pay and the
 * payload did not carry `confirmDecrease: true`. The diff behind that refusal
 * is recomputed on the server; a preview supplied by the caller is never read.
 */
export async function upsertProgramRateOverrideWithReprice(input: unknown) {
  const session = await requireRole("admin");
  const coachId = coachIdFromInput(input);
  if (coachId) await assertCoachNotArchived(coachId);
  const result = await upsertProgramRateOverrideWithRepriceInternal(
    session.user,
    input,
  );
  // Rate surfaces (the card that was just edited + the coaches list).
  revalidateOverrideSurfaces(result.override.coachId);
  // Pay surfaces. Unconditional even on the not_requested path: cheap, and it
  // keeps "did we remember to bust the cache" from depending on a branch.
  revalidateWorkPaySurfaces();
  return result;
}

/**
 * READ-ONLY. SPEC §7 — the rate history behind the 3-dot menu beside this
 * coach's rate on this program: every change newest-first, sourced from the
 * `effective_from` column plus the existing audit trail.
 *
 * Admin-gated like everything else on this surface, and gated HERE rather than
 * in the component, because the component is a client component: it is handed
 * this function and can never reach a database of its own. No archived-coach
 * guard — reading an archived coach's own history is exactly what the
 * read-only render of this page is for.
 */
export async function getProgramRateOverrideHistory(
  coachId: string,
  programId: string,
) {
  await requireRole("admin");
  return readProgramRateOverrideHistory(coachId, programId);
}

// Explicit args (matches deleteRateOverride convention). The internal
// still Zod-parses for defense-in-depth.
export async function deleteProgramRateOverride(
  coachId: string,
  programId: string,
) {
  const session = await requireRole("admin");
  await assertCoachNotArchived(coachId);
  await deleteProgramRateOverrideInternal(session.user, {
    coachId,
    programId,
  });
  revalidateOverrideSurfaces(coachId);
}

// Update Venmo + Zelle handles for a coach. Revalidates the coach
// detail page (so the chip on the handles card re-renders) and
// /admin/payments (so the reconciliation hints there pick up the
// change). No revalidate on /admin/coaches — that page doesn't show
// handles.
export async function updateCoachHandles(input: unknown) {
  const session = await requireRole("admin");
  // Handles payloads key the target on `userId` (not `coachId`).
  if (input && typeof input === "object" && "userId" in input) {
    const userId = (input as { userId: unknown }).userId;
    if (typeof userId === "string") await assertCoachNotArchived(userId);
  }
  const result = await updateUserHandlesInternal(session.user, input);
  revalidatePath(`/admin/coaches/${result.id}`);
  revalidatePath("/admin/payments");
  return result;
}

// QA2 #8 — update the admin-only free-text notes on a coach. Revalidates
// the coach detail page so the Notes card re-renders with the saved text.
// Notes are never shown on coach-facing surfaces, so no other revalidate.
export async function updateCoachNotes(input: unknown) {
  const session = await requireRole("admin");
  const coachId = coachIdFromInput(input);
  if (coachId) await assertCoachNotArchived(coachId);
  const result = await updateCoachNotesInternal(session.user, input);
  revalidatePath(`/admin/coaches/${result.id}`);
  return result;
}

// Schedule Manager Part 2 — grant/revoke the schedule_admin flag on a
// coach. requireRole("admin") is the anti-escalation boundary: a coach
// (even a flagged "Schedule Manager") is redirected before reaching the
// mutation, so no one can self-grant or grant another coach. Revalidates
// the coach detail page (so the Schedule Manager card re-renders the new
// state) and /admin/coaches (the list may surface the flag later).
export async function setCoachScheduleAdmin(input: unknown) {
  const session = await requireRole("admin");
  const { coachId, enabled } = setScheduleAdminSchema.parse(input);
  await assertCoachNotArchived(coachId);
  const result = await setScheduleAdminInternal(session.user, coachId, enabled);
  revalidatePath(`/admin/coaches/${coachId}`);
  revalidatePath("/admin/coaches");
  return result;
}

// QA2 #6 — set how FUTURE logged work is paid for this coach (hourly vs
// a flat per-session amount). Does NOT retroactively change already-logged
// work — the billing layer snapshots the basis at log time. Revalidates
// the coach detail page so the Work-pay-mode card re-renders.
export async function updateCoachPaySettings(input: unknown) {
  const session = await requireRole("admin");
  const coachId = coachIdFromInput(input);
  if (coachId) await assertCoachNotArchived(coachId);
  const result = await updateCoachPaySettingsInternal(session.user, input);
  revalidatePath(`/admin/coaches/${result.coachId}`);
  return result;
}

// #28 archive coach. REVERSIBLE soft-delete that PRESERVES name/email —
// this is what the danger-zone "Archive coach" card calls. Mirrors the
// revalidation set of deleteCoach / restoreCoach so the coach leaves the
// active surfaces and appears (with real identity) on /admin/coaches/archive.
export async function archiveCoach(coachId: string) {
  const session = await requireRole("admin");
  await archiveCoachInternal(session.user, coachId);
  revalidatePath(`/admin/coaches/${coachId}`);
  revalidatePath("/admin/coaches");
  revalidatePath("/admin/coaches/archive");
  revalidatePath("/admin/sessions");
  revalidatePath("/admin/schedule");
  revalidatePath("/admin/reports");
  revalidatePath("/admin/audit");
}

// J9 account deletion (GDPR / "remove my info"). Soft-delete + ANONYMIZE.
// See src/lib/server/user-actions.ts for the shape; this wrapper gates
// with requireRole and revalidates every surface that lists active
// coaches. No longer wired to the interactive UI (the Archive card now
// uses the non-anonymizing archiveCoach above) — kept exported for the
// privacy-erasure path / scripts.
export async function deleteCoach(coachId: string) {
  const session = await requireRole("admin");
  await deleteCoachInternal(session.user, { coachId });
  revalidatePath(`/admin/coaches/${coachId}`);
  revalidatePath("/admin/coaches");
  revalidatePath("/admin/sessions");
  revalidatePath("/admin/schedule");
  revalidatePath("/admin/reports");
  revalidatePath("/admin/audit");
}
