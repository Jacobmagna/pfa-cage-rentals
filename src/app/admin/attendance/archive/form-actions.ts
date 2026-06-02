"use server";

// Form-action wrapper for the Archive sub-tab's bulk Restore button.
// restoreAthletes throws no typed errors, so there's nothing to catch —
// any unknown error bubbles to the error boundary. Mirrors the roster's
// archiveAthletesAction Result shape.

import { restoreAthletes } from "./actions";

export type RestoreAthletesResult =
  | { ok: true; restoredAt: number }
  | { ok: false; error: { code: string; message: string } };

export async function restoreAthletesAction(
  ids: string[],
): Promise<RestoreAthletesResult> {
  await restoreAthletes(ids);
  return { ok: true, restoredAt: Date.now() };
}
